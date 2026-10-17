// The read-depth rule (v51 §10.2, the maintainer's ruling; design 4.1 §8): `mp read status` is
// layer 0 only when no subtask's state changed since the user last asked, else layer 0 plus the
// layer-1 entries of exactly the changed subtasks (a Reviewer's rejection and an exploration's
// conclusion are changes); the count of the persistently blocked subtasks is always in layer 0,
// and `mp read blocked` lists them with their reason and next step; the cursor moves only without
// --no-mark.

import assert from 'node:assert/strict';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { sweepThenClean } from './exploration-exits.ts';
import { resolveSubtasks, type Layer1Entry } from '../src/cli/layers.ts';
import { markAsked } from '../src/cli/status.ts';
import type { MissionId } from '../src/common/ids.ts';
import { drain } from '../src/evaluator/index.ts';
import { cal1Pass, cal2Escalate, cal2Pass } from '../src/flow/scripted.ts';
import { answerEscalation } from '../src/flow/secretary.ts';
import { pmAnswer, pmDispatch, pmMission, pmNext, pmPlan, pmRelease, pmReopenExploration, pmRequirement, pmSay, pmWithdrawRequirement, type ProcessContext } from '../src/process/index.ts';
import { dispatchView, recordEvidenceRequest, seatCheckout, seatRerun } from '../src/process/seat.ts';
import type { CrititorCard } from '../src/seat/cards/crititor.ts';
import type { AuthorCard } from '../src/seat/cards/researcher.ts';
import type { StabilizerCard } from '../src/seat/cards/stabilizer.ts';
import { cli } from './cli-fixtures.ts';
import { addDetailedPlan, addMissionToReview, addPlan, CHECK_JS, ENV_B, handBack, processProject, readAll, readyOf, reviewerPass, startAddMission, step, write, type ProcessProject } from './process-fixtures.ts';

const keys = (r: { json: { result: { changed: Array<{ kind: string; id: string; mission: string }> } } }): string[] => r.json.result.changed.map((e) => `${e.mission}/${e.kind}/${e.id}`).sort();

/** An exploration planned and through Calibrator ①: the author's turn. */
async function explorationStart(p: ProcessProject, mission: string, rounds = 3): Promise<void> {
  const ctx = p.ctx;
  pmMission(ctx, mission);
  const w = pmSay(ctx, `Find a cache design with no obvious logical hole. The details are yours to decide. (${mission})`).words;
  await pmRequirement(ctx, { mission, item: 'a1', type: 'authorization', text: "Details are the PM's", quote: 'The details are yours to decide', words: w });
  await pmPlan(ctx, {
    mission,
    words: [w],
    plan: {
      format: 'mp4.pm-plan.v1',
      mission,
      round: 1,
      order: 'free',
      elements: [
        {
          id: 'x',
          kind: 'exploration',
          text: 'Design the cache',
          provenance: { by: 'user', words: w, quote: 'Find a cache design' },
          exploration: { id: 'X1', deliverable: 'a cache design', fuzzyGoal: { quote: 'no obvious logical hole', words: w }, attackScope: ['internal contradiction'], decision: { id: 'D1', type: 'structure' }, budget: { rounds, micros: null }, stop: '', research: false },
          after: [],
          items: [],
        },
      ],
      goalsBeyond: [],
      authorizations: ['a1'],
    },
  });
  await step(ctx, 'calibrator-1', (c) => cal1Pass(c));
}

async function exploration(p: ProcessProject, mission: string): Promise<void> {
  const ctx = p.ctx;
  await explorationStart(p, mission);
  await step(ctx, 'researcher-author', () => ({ step: 'submit', message: 'v1', artifact: 'v1: an LRU cache', dispositions: [], directionQuestions: [], attempts: [] }));
  await step(ctx, 'crititor', () => ({ findings: [{ severity: 'serious', class: 'cost out of control', title: 'the cache costs memory', basis: 'the passage', consequence: 'memory', direction: 'size it', evidence: [] }], rechecks: [], settled: [], reply: 'assessment' }));
  await step(ctx, 'researcher-author', (c: AuthorCard) => ({ step: 'submit', message: 'v2', artifact: 'v2: a sized LRU cache', dispositions: c.openFindings.map((f) => ({ finding: f.id, action: 'revise', note: 'sized' })), directionQuestions: [], attempts: [] }));
  await step(ctx, 'stabilizer', (c: StabilizerCard) => ({ findings: c.findings.map((f) => ({ finding: f.id, verdict: 'out-of-scope', severity: 'general', reason: 'outside the scope', question: '' })), round: { verdict: 'on-track', reason: 'answers the question', question: '' } }));
  await step(ctx, 'crititor', (c: CrititorCard) => ({ findings: [], rechecks: c.priorFindings.filter((f) => f.status === 'awaiting-recheck').map((f) => ({ finding: f.id, resolved: 'yes', reason: 'fixed', evidence: [] })), settled: [], reply: 'ok' }));
  // every attack round is stabilized; then only the closing attacker is left
  await step(ctx, 'stabilizer', (c: StabilizerCard) => ({ findings: c.findings.map((f) => ({ finding: f.id, verdict: 'in-scope', severity: 'general', reason: 'checked', question: '' })), round: { verdict: 'on-track', reason: 'answers the question', question: '' } }));
}

describe('mp read status: layer 0, plus the layer-1 entries of exactly the subtasks that changed since the user last asked', () => {
  const p = processProject();
  after(() => p.cleanup());

  it('nothing changed: layer 0 only; a Reviewer rejection and an exploration conclusion: exactly those two subtasks', async () => {
    await addMissionToReview(p, 'm1');
    await exploration(p, 'm2');
    const first = await cli(p.dir, ['read', 'status', '--json']);
    assert.equal(first.code, 0, first.err + first.out);
    assert.ok(first.json.result.changed.length > 0, 'the first ask lists every subtask');
    const quiet = await cli(p.dir, ['read', 'status', '--json']);
    assert.deepEqual(quiet.json.result.changed, [], 'no change since the last ask: layer 0 only');
    assert.match((await cli(p.dir, ['read', 'status', '--no-mark'])).out, /Nothing changed since the user last asked/);

    // a rejection and a conclusion
    await step(p.ctx, 'reviewer', (c) => {
      const pass = reviewerPass(c) as { judgments: Array<Record<string, unknown>> };
      return { ...pass, judgments: pass.judgments.map((j) => ({ ...j, met: 'no', reason: 'the check is missing a case' })), verdict: 'rework' };
    });
    await step(p.ctx, 'crititor', (c: CrititorCard) => {
      assert.equal(c.fresh, true, 'the closing attacker');
      return { findings: [], rechecks: [], settled: [], reply: 'ok' };
    });
    await step(p.ctx, 'stabilizer', () => ({ findings: [], round: { verdict: 'on-track', reason: 'answers the question', question: '' } }));
    // --no-mark keeps the cursor: the same changes twice
    const a = await cli(p.dir, ['read', 'status', '--json', '--no-mark']);
    const b = await cli(p.dir, ['read', 'status', '--json', '--no-mark']);
    assert.deepEqual(keys(a), ['m1/task/impl', 'm2/exploration/X1'], JSON.stringify(a.json.result.changed));
    assert.deepEqual(keys(b), keys(a));
    const impl = a.json.result.changed.find((e: { id: string }) => e.id === 'impl');
    assert.match(impl.label, /rework/);
    const x = a.json.result.changed.find((e: { id: string }) => e.id === 'X1');
    assert.match(x.label, /^concluded/);
    const text = await cli(p.dir, ['read', 'status']);
    assert.match(text.out, /Changed since the user last asked \(event \d+\):\n {2}m1 task impl — .* \[building \(attempt 2\), after a rework \(reviewer\)\] \(last change /);
    assert.match(text.out, /Persistently blocked: 0/);
    // marked: asked again, nothing changed
    assert.deepEqual((await cli(p.dir, ['read', 'status', '--json'])).json.result.changed, []);
  });
});

describe('mp read blocked: the blocked subtasks with their reason and next step; their count in layer 0', () => {
  const p = processProject();
  after(() => p.cleanup());

  it('a step held by a stop and a lineage whose re-dispatches are used up', async () => {
    await startAddMission(p.ctx, 'm4');
    await startAddMission(p.ctx, 'm5');
    assert.equal((await cli(p.dir, ['pm', 'stop', 'stop m4', '--scope', 'mission:m4'])).code, 0);
    // m5: Calibrator ① released three times: its re-dispatch loop is used up (WI-08)
    for (let i = 0; i < 3; i++) {
      const s = await readyOf(p.ctx, 'calibrator-1');
      const d = pmDispatch(p.ctx, s.step, { filledBy: 'test/scripted' });
      const r = await pmRelease(p.ctx, d.dispatch, 'ended');
      if (r.exhausted) break;
    }
    const st = await cli(p.dir, ['read', 'status', '--json', '--no-mark']);
    assert.equal(st.json.result.blocked, 2, JSON.stringify(st.json.result));
    assert.match((await cli(p.dir, ['read', 'status', '--no-mark'])).out, /Persistently blocked: 2 \(why: mp read blocked\)/);
    const bl = await cli(p.dir, ['read', 'blocked', '--json']);
    assert.equal(bl.code, 0, bl.err);
    const xs = bl.json.result.blocked as Array<{ mission: string; blocked: { because: string; next: string; wi: string | null } }>;
    const stop = xs.find((e) => e.mission === 'm4' as MissionId);
    assert.ok(stop !== undefined && /a stop covers it/.test(stop.blocked.because) && /stop-release/.test(stop.blocked.next), JSON.stringify(xs));
    const loop = xs.find((e) => e.mission === 'm5' as MissionId);
    assert.ok(loop !== undefined && /loop-exhausted: Task cal1\.m5\.1 used up its attempts/.test(loop.blocked.because) && loop.blocked.wi === 'WI-08' && /the Secretary decides/.test(loop.blocked.next), JSON.stringify(xs));
    const text = await cli(p.dir, ['read', 'blocked']);
    assert.match(text.out, /^Blocked: 2/);
    assert.match(text.out, /blocked because .* \/ next: /);
  });
});

// ---- review round 1 of the read-depth code: one resolver, the producers' encoders, the cursor at the answer's head

/** A context two hours on (a dispatch then counts as in flight too long). */
const later = (ctx: ProcessContext): ProcessContext => ({ ...ctx, now: () => Date.now() + 2 * 60 * 60_000 }) as ProcessContext;
const brief = (xs: readonly Layer1Entry[]): string => JSON.stringify(xs.map(({ mission, kind, id, label, blocked }) => ({ mission, kind, id, label, blocked: blocked?.because ?? null })));

/** The add mission up to its Constructor (the detailed plan's one task under the id given). */
async function toConstructor(p: ProcessProject, mission: string, taskId = 'impl'): Promise<void> {
  await startAddMission(p.ctx, mission);
  await step(p.ctx, 'calibrator-1', (c) => cal1Pass(c));
  const plan = addDetailedPlan(mission) as { tasks: Array<{ id: string }> };
  plan.tasks[0]!.id = taskId;
  await step(p.ctx, 'architect-decompose', () => plan);
  await step(p.ctx, 'calibrator-2', (c) => cal2Pass(c));
}

/** One Constructor attempt: dispatched, built, handed back (`flying` runs while it is in flight). */
async function build(p: ProcessProject, n: number, flying?: () => Promise<void>): Promise<void> {
  const s = await readyOf(p.ctx, 'constructor');
  const d = pmDispatch(p.ctx, s.step);
  await flying?.();
  const wt = join(p.dir, d.worktree!);
  write(wt, 'src/add.js', `exports.add = (a, b) => a + b; // v${n}\n`);
  write(wt, 'src/check.js', CHECK_JS);
  const a = await handBack(p.ctx, d.dispatch, { done: `implemented add v${n}`, unmet_standards: [], unfixed_problems: [], decisions_needed: [] });
  assert.equal(a.kind, 'recorded', JSON.stringify(a));
}

async function rework(p: ProcessProject, why: string): Promise<void> {
  await step(p.ctx, 'reviewer', (c) => {
    const pass = reviewerPass(c) as { judgments: Array<Record<string, unknown>> };
    return { ...pass, judgments: pass.judgments.map((j) => ({ ...j, met: 'no', reason: why })), findings: [why], verdict: 'rework' };
  });
}

describe('one state resolver: the changed list, the blocked list and the layer-0 count from one computation', () => {
  const ps: ProcessProject[] = [];
  const fresh = (): ProcessProject => {
    const p = processProject();
    ps.push(p);
    return p;
  };
  after(() => sweepThenClean(ps));

  it('two reworks, then a pass on the last allowed attempt: nothing is blocked during the third attempt or after acceptance', async () => {
    const p = fresh();
    await toConstructor(p, 'm1');
    await build(p, 1);
    await rework(p, 'missing case one');
    await build(p, 2);
    await rework(p, 'missing case two');
    const during = await resolveSubtasks(p.ctx);
    assert.deepEqual(during.blocked, [], brief(during.blocked));
    await build(p, 3, async () => {
      const st = await cli(p.dir, ['read', 'status', '--json', '--no-mark']);
      assert.equal(st.json.result.blocked, 0, `the third attempt in flight is not blocked: ${JSON.stringify(st.json.result)}`);
    });
    await step(p.ctx, 'reviewer', (c) => reviewerPass(c));
    await pmNext(p.ctx);
    const done = await resolveSubtasks(p.ctx);
    assert.deepEqual(done.blocked, [], brief(done.blocked));
    assert.match(done.entries.find((e) => e.kind === 'task' && e.id === 'impl')!.label, /^accepted/);
    const bl = await cli(p.dir, ['read', 'blocked', '--json']);
    assert.deepEqual(bl.json.result.blocked, []);
    assert.equal((await cli(p.dir, ['read', 'status', '--json', '--no-mark'])).json.result.blocked, 0);
  });

  it('a hyphenated task id: its dispatch shows on its own entry, and its blocked entry has the real id, label and time', async () => {
    const p = fresh();
    await toConstructor(p, 'm1', 'fix-mean-impl');
    assert.equal((await cli(p.dir, ['read', 'status', '--json'])).code, 0);
    const s = await readyOf(p.ctx, 'constructor');
    const d = pmDispatch(p.ctx, s.step);
    const st = await cli(p.dir, ['read', 'status', '--json', '--no-mark']);
    const changed = st.json.result.changed as Layer1Entry[];
    const e = changed.find((x) => x.kind === 'task' && x.id === 'fix-mean-impl');
    assert.ok(e !== undefined && e.label.includes(`constructor ${d.dispatch} in flight`), JSON.stringify(changed));
    assert.ok(!changed.some((x) => x.id !== 'fix-mean-impl' && x.label.includes(d.dispatch)), 'the dispatch is on no other entry');
    const r = await resolveSubtasks(later(p.ctx));
    assert.equal(r.blocked.length, 1, brief(r.blocked));
    const b = r.blocked[0]!;
    assert.equal(b.kind, 'task');
    assert.equal(b.id, 'fix-mean-impl');
    assert.match(b.label, new RegExp(`constructor ${d.dispatch} in flight`));
    assert.ok(b.changedAt !== null && b.changedRev > 0, JSON.stringify(b));
    assert.match(b.blocked!.because, new RegExp(`dispatch ${d.dispatch} \\(constructor\\) has been in flight for`));
    assert.equal(b.blocked!.wi, 'WI-28');
  });

  it("withdrawing the requirement of an accepted task: the task is in the changed list, with its product's proof label", async () => {
    const p = fresh();
    await toConstructor(p, 'm1');
    await build(p, 1);
    await step(p.ctx, 'reviewer', (c) => reviewerPass(c));
    await pmNext(p.ctx);
    const before = await cli(p.dir, ['read', 'status', '--json']);
    const impl0 = (before.json.result.changed as Layer1Entry[]).find((e) => e.kind === 'task' && e.id === 'impl');
    assert.ok(impl0 !== undefined && /^accepted/.test(impl0.label), JSON.stringify(before.json.result.changed));
    await pmWithdrawRequirement(p.ctx, { mission: 'm1', item: 'g1', reason: 'the user changed their mind' });
    await pmNext(p.ctx);
    const st = await cli(p.dir, ['read', 'status', '--json', '--no-mark']);
    const impl = (st.json.result.changed as Layer1Entry[]).find((e) => e.kind === 'task' && e.id === 'impl');
    assert.ok(impl !== undefined, JSON.stringify(st.json.result.changed));
    assert.match(impl.label, /^accepted.*product basis-withdrawn/);
  });

  it('a write between building the answer and marking it appears in the next status', async () => {
    const p = fresh();
    await startAddMission(p.ctx, 'm1');
    assert.equal((await cli(p.dir, ['read', 'status', '--json'])).code, 0);
    const answer = await resolveSubtasks(p.ctx);
    // a write lands while the answer is on its way
    const w = pmSay(p.ctx, 'Also a subtract function, please. (m1)').words;
    await pmRequirement(p.ctx, { mission: 'm1', item: 'g2', type: 'goal', text: 'A subtract function', quote: 'a subtract function', words: w });
    assert.ok(!answer.entries.some((e) => e.kind === 'requirement' && e.title.includes('subtract')));
    markAsked(p.ctx, answer.head);
    const next = await cli(p.dir, ['read', 'status', '--json']);
    const changed = next.json.result.changed as Layer1Entry[];
    assert.ok(changed.some((e) => e.kind === 'requirement' && e.title.includes('A subtract function')), JSON.stringify(changed));
    assert.deepEqual((await cli(p.dir, ['read', 'status', '--json'])).json.result.changed, [], 'marked at the head the answer was built from');
  });

  it('one subtask with two reasons to be blocked is counted once', async () => {
    const p = fresh();
    await toConstructor(p, 'm1');
    for (let n = 1; n <= 3; n++) {
      await build(p, n);
      await rework(p, `missing case ${n}`);
    }
    // the reworks are used up: the escalation is open and its Secretary step is queued; a stop then holds that step
    await readyOf(p.ctx, 'secretary');
    const stop = await cli(p.dir, ['pm', 'stop', 'stop m1', '--scope', 'mission:m1', '--json']);
    assert.equal(stop.code, 0, stop.err);
    const r = await resolveSubtasks(p.ctx);
    assert.equal(r.blocked.length, 1, brief(r.blocked));
    const b = r.blocked[0]!;
    assert.equal(b.kind, 'task');
    assert.equal(b.id, 'impl');
    assert.match(b.blocked!.because, /escalation .* is open \(loop-exhausted: Task impl: the reworks are used up/);
    assert.match(b.blocked!.because, /is held: a stop/);
    const st = await cli(p.dir, ['read', 'status', '--json', '--no-mark']);
    assert.equal(st.json.result.blocked, 1);
    const bl = await cli(p.dir, ['read', 'blocked', '--json']);
    assert.equal(bl.json.result.blocked.length, 1);
    // the stop released: still listed (the escalation is open) until the Secretary's decision is carried out
    assert.equal((await cli(p.dir, ['pm', 'stop-release', stop.json.result.stop as string, '--json'])).json.result.released, true);
    const open = await resolveSubtasks(p.ctx);
    assert.equal(open.blocked.length, 1, brief(open.blocked));
    assert.doesNotMatch(open.blocked[0]!.blocked!.because, /held/);
    await step(p.ctx, 'secretary', () => ({ option: 'grant', classification: 'detail', authorization: null, reason: 'one more try', instructions: '', grantExtra: 1, notice: '', mayMatter: false }));
    await readyOf(p.ctx, 'constructor');
    const granted = await resolveSubtasks(p.ctx);
    assert.deepEqual(granted.blocked, [], brief(granted.blocked));
  });

  it('an exploration stopped for budget, its ruling queued: one blocked entry, the exploration', async () => {
    const p = fresh();
    await explorationStart(p, 'm2', 1);
    const ctx = p.ctx;
    await step(ctx, 'researcher-author', () => ({ step: 'submit', message: 'v1', artifact: 'v1: an LRU cache', dispositions: [], directionQuestions: [], attempts: [] }));
    await step(ctx, 'crititor', () => ({ findings: [{ severity: 'serious', class: 'internal contradiction', title: 'two answers', basis: 'the passage', consequence: 'no answer', direction: 'pick one', evidence: [] }], rechecks: [], settled: [], reply: 'assessment' }));
    await step(ctx, 'researcher-author', (c: AuthorCard) => ({ step: 'submit', message: 'v2', artifact: 'v2: one answer', dispositions: c.openFindings.map((f) => ({ finding: f.id, action: 'revise', note: 'one answer' })), directionQuestions: [], attempts: [] }));
    await step(ctx, 'stabilizer', (c: StabilizerCard) => ({ findings: c.findings.map((f) => ({ finding: f.id, verdict: 'in-scope', severity: 'serious', reason: 'checked', question: '' })), round: { verdict: 'on-track', reason: 'answers the question', question: '' } }));
    const sec = await readyOf(ctx, 'secretary');
    const r = await resolveSubtasks(ctx);
    const x = r.entries.find((e) => e.kind === 'exploration' && e.id === 'X1');
    assert.ok(x !== undefined && /^stopped \(budget-exhausted\)/.test(x.label), brief(r.entries));
    assert.equal(r.blocked.length, 1, brief(r.blocked));
    assert.equal(r.blocked[0]!.kind, 'exploration');
    assert.equal(r.blocked[0]!.id, 'X1');
    assert.match(r.blocked[0]!.blocked!.because, /exploration-budget/);
    const bl = await cli(p.dir, ['read', 'blocked', '--json']);
    assert.equal(bl.json.result.blocked.length, 1);
    assert.equal((await cli(p.dir, ['read', 'status', '--json', '--no-mark'])).json.result.blocked, 1);
    // the ruling's Secretary step belongs to the exploration: its dispatch is part of the exploration's state (a change),
    // and in flight too long it is a second reason of the same entry
    assert.equal((await cli(p.dir, ['read', 'status', '--json'])).code, 0);
    const d = pmDispatch(ctx, sec.step);
    const st = await cli(p.dir, ['read', 'status', '--json', '--no-mark']);
    const xe = (st.json.result.changed as Layer1Entry[]).find((e) => e.kind === 'exploration' && e.id === 'X1');
    assert.ok(xe !== undefined && xe.label.includes(`secretary ${d.dispatch} in flight`), JSON.stringify(st.json.result.changed));
    const aged = await resolveSubtasks(later(ctx));
    assert.equal(aged.blocked.length, 1, brief(aged.blocked));
    assert.equal(aged.blocked[0]!.kind, 'exploration');
    assert.match(aged.blocked[0]!.blocked!.because, new RegExp(`exploration-budget.*; dispatch ${d.dispatch} \\(secretary\\) has been in flight`));
  });
});

// ---- review round 2: the exploration's current state and its product's label; the next step of a decision waiting on the user

/** An exploration whose rebuttal rests on an experiment (`node probe.js`), converged and settled with a proven product. */
async function convergedOnExperiment(p: ProcessProject, m: string, rounds = 6): Promise<{ readonly evidence: string; readonly drive: () => Promise<void> }> {
  pmMission(p.ctx, m);
  const w = pmSay(p.ctx, `Find a cache design with no obvious logical hole. The details are yours to decide. (${m})`).words;
  await pmRequirement(p.ctx, { mission: m, item: 'a1', type: 'authorization', text: "Details are the PM's", quote: 'The details are yours to decide', words: w });
  await pmPlan(p.ctx, {
    mission: m,
    words: [w],
    plan: {
      format: 'mp4.pm-plan.v1',
      mission: m,
      round: 1,
      order: 'free',
      elements: [
        {
          id: 'x',
          kind: 'exploration',
          text: 'Design the cache',
          provenance: { by: 'user', words: w, quote: 'Find a cache design' },
          exploration: { id: 'X1', deliverable: 'a cache design', fuzzyGoal: { quote: 'no obvious logical hole', words: w }, attackScope: ['internal contradiction'], decision: { id: 'D1', type: 'structure' }, budget: { rounds, micros: null }, stop: '', research: false },
          after: [],
          items: [],
        },
      ],
      goalsBeyond: [],
      authorizations: ['a1'],
    },
  });
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
  /** The attacker's re-checks (resting on the run) and the Stabilizer's judgments, until nothing of theirs is ready. */
  const drive = async (): Promise<void> => {
    for (let i = 0; i < 10; i++) {
      const k = (await pmNext(p.ctx)).ready[0]?.kind;
      if (k === 'stabilizer') await step(p.ctx, 'stabilizer', (c) => ({ findings: c.findings.map((f: { id: string }) => ({ finding: f.id, verdict: 'in-scope', severity: 'serious', reason: 'checked', question: '' })), round: { verdict: 'on-track', reason: 'answers the question', question: '' } }));
      // a re-check cites the rebuttal's current record (after a rerun, its replacement)
      else if (k === 'crititor') await step(p.ctx, 'crititor', (c: CrititorCard) => ({ findings: [], rechecks: c.priorFindings.filter((f) => f.status === 'awaiting-recheck').map((f) => ({ finding: f.id, resolved: 'yes', reason: 'the run covers it', evidence: [f.disposition?.evidence ?? evidence] })), settled: [], reply: 'ok' }));
      else return;
    }
  };
  await drive();
  return { evidence, drive };
}

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

const exploreEntry = (r: { json: { result: { changed: Layer1Entry[] } } }): Layer1Entry | undefined => r.json.result.changed.find((e) => e.kind === 'exploration' && e.id === 'X1');

/** Three reworks with a cap of two: the loop is used up and its escalation waits for the Secretary. */
async function reworksUsedUp(p: ProcessProject): Promise<void> {
  await toConstructor(p, 'm1');
  for (let n = 1; n <= 3; n++) {
    await build(p, n);
    await rework(p, `missing case ${n}`);
  }
}

describe('review round 2: an exploration from its machine state and its product label; a decision waiting on the user', () => {
  const ps: ProcessProject[] = [];
  const fresh = (o: Parameters<typeof processProject>[0] = {}): ProcessProject => {
    const p = processProject(o);
    ps.push(p);
    return p;
  };
  after(() => sweepThenClean(ps));
  const PROBE = { files: { 'probe.js': "console.log('status: ok');\n" } };

  it('a converged exploration reopened after a move on the PM\'s word: not "concluded" while its evidence is re-checked, the product from an older environment; concluded again after the re-check', async () => {
    const p = fresh(PROBE);
    const { drive } = await convergedOnExperiment(p, 'm2');
    const first = await cli(p.dir, ['read', 'status', '--json']);
    assert.match(exploreEntry(first)?.label ?? '', /^concluded: conclusion \(converged\), product proven/, JSON.stringify(first.json.result.changed));
    // the folder opens on another machine; the PM's next step: a notice, nothing reopened (4.1.2)
    p.reopen(ENV_B);
    const told = await cli(p.dir, ['pm', 'next', '--json'], { env: ENV_B });
    assert.equal(told.code, 0, told.err);
    assert.ok(!told.json.result.ready.some((r: { kind: string }) => r.kind === 'constructor-experiment'), JSON.stringify(told.json.result.ready));
    assert.ok(told.json.result.notices.some((n: { category: string }) => n.category === 'exploration-older-environment'), JSON.stringify(told.json.result.notices));
    // the PM judges the change matters: its word reopens it
    const word = await cli(p.dir, ['pm', 'reopen-exploration', 'm2', 'X1'], { env: ENV_B });
    assert.equal(word.code, 0, word.err);
    const nx = await cli(p.dir, ['pm', 'next', '--json'], { env: ENV_B });
    assert.equal(nx.code, 0, nx.err);
    assert.ok(nx.json.result.ready.some((r: { kind: string }) => r.kind === 'constructor-experiment'), JSON.stringify(nx.json.result.ready));
    const st = await cli(p.dir, ['read', 'status', '--json'], { env: ENV_B });
    const x = exploreEntry(st);
    assert.ok(x !== undefined, JSON.stringify(st.json.result.changed));
    assert.doesNotMatch(x.label, /^concluded/);
    assert.match(x.label, /; concluded earlier: conclusion \(converged\), re-checking its evidence after an environment change, product proven \(older environment\)/);
    assert.deepEqual((await cli(p.dir, ['read', 'blocked', '--json'], { env: ENV_B })).json.result.blocked, []);
    // the rerun, the attacker's re-check and its Stabilizer: concluded again, the product proven
    await experiment(p);
    await drive();
    const again = await cli(p.dir, ['read', 'status', '--json'], { env: ENV_B });
    assert.match(exploreEntry(again)?.label ?? '', /^concluded: conclusion \(converged\), product proven/, JSON.stringify(again.json.result.changed));
  });

  it('4.1.2: an environment change alone changes no label: the conclusion stays, its product shown from an older environment, and it is no change of the exploration', async () => {
    const p = fresh(PROBE);
    await convergedOnExperiment(p, 'm2');
    const first = await cli(p.dir, ['read', 'status', '--json']);
    const before = exploreEntry(first)!;
    p.reopen(ENV_B);
    p.ctx.environment();
    drain(p.ctx.memory);
    const st = await cli(p.dir, ['read', 'status', '--json', '--no-mark'], { env: ENV_B });
    const all = (await resolveSubtasks(p.ctx)).entries.find((e) => e.kind === 'exploration' && e.id === 'X1')!;
    assert.match(all.label, /^concluded: conclusion \(converged\), product proven \(older environment\)/);
    assert.equal(all.changedRev, before.changedRev, 'no label moved');
    assert.equal(exploreEntry(st), undefined, 'not a change since the last ask');
  });

  it('the Secretary hands the decision to the user: mp read blocked says to ask the user; after mp pm answer it is carried out; then nothing is blocked', async () => {
    const p = fresh();
    await reworksUsedUp(p);
    await step(p.ctx, 'secretary', () => ({ option: 'ask-user', classification: 'needs-user', authorization: null, reason: 'the user decides', instructions: '', grantExtra: 0, notice: 'ask the user', mayMatter: false }));
    for (let i = 0; i < 2; i++) await pmNext(p.ctx);
    const nx = await cli(p.dir, ['pm', 'next', '--json']);
    const esc = nx.json.result.waitingOnUser[0]?.escalation as string;
    assert.ok(esc !== undefined, JSON.stringify(nx.json.result));
    const bl = await cli(p.dir, ['read', 'blocked', '--json']);
    assert.equal(bl.json.result.blocked.length, 1, JSON.stringify(bl.json.result));
    const b = bl.json.result.blocked[0] as Layer1Entry;
    assert.equal(b.id, 'impl');
    assert.match(b.label, /^reworks used up \(2 of 2\), product negated/);
    assert.match(b.blocked!.next, new RegExp(`^ask the user; then mp pm answer m1 ${esc.replace(/\./g, '\\.')} --option <grant\\|replan\\|abandon>`));
    assert.doesNotMatch(b.blocked!.next, /carried out/);
    assert.equal(b.blocked!.wi, 'WI-08');
    assert.match((await cli(p.dir, ['read', 'blocked'])).out, /next: ask the user; then mp pm answer m1 /);
    // the user's answer recorded (what mp pm answer writes, before its own flow step runs): carried out next
    const w = pmSay(p.ctx, 'Give it one more try.').words;
    await answerEscalation(p.ctx.ports(), { mission: 'm1' as MissionId, escalation: esc, option: 'grant', grantExtra: 1, words: `Give it one more try. (${w})` });
    const answered = await resolveSubtasks(p.ctx);
    assert.equal(answered.blocked.length, 1, brief(answered.blocked));
    assert.equal(answered.blocked[0]!.blocked!.next, 'the decision is carried out on the next mp pm next');
    await pmNext(p.ctx);
    const done = await resolveSubtasks(p.ctx);
    assert.deepEqual(done.blocked, [], brief(done.blocked));
    await readyOf(p.ctx, 'constructor');
  });

  it('the Secretary seat ends without deciding (a program decision, needs-user): mp read blocked says to ask the user', async () => {
    const p = fresh();
    await reworksUsedUp(p);
    for (let i = 0; i < 4; i++) {
      const s = (await pmNext(p.ctx)).ready.find((r) => r.kind === 'secretary');
      if (s === undefined) break;
      const d = pmDispatch(p.ctx, s.step);
      await pmRelease(p.ctx, d.dispatch, 'abandoned');
    }
    const nx = await cli(p.dir, ['pm', 'next', '--json']);
    const esc = nx.json.result.waitingOnUser[0]?.escalation as string;
    assert.ok(esc !== undefined, JSON.stringify(nx.json.result));
    const r = await resolveSubtasks(p.ctx);
    assert.equal(r.blocked.length, 1, brief(r.blocked));
    assert.match(r.blocked[0]!.blocked!.next, new RegExp(`^ask the user; then mp pm answer m1 ${esc.replace(/\./g, '\\.')} `));
    assert.doesNotMatch(r.blocked[0]!.blocked!.next, /carried out/);
    // mp pm answer records the answer and carries it out in the same step: nothing is blocked
    const w = (await cli(p.dir, ['pm', 'say', 'Give it one more try.', '--json'])).json.result.words as string;
    const ans = await cli(p.dir, ['pm', 'answer', 'm1', esc, '--option', 'grant', '--extra', '1', '--words', w, '--json']);
    assert.equal(ans.code, 0, ans.err + ans.out);
    assert.deepEqual((await cli(p.dir, ['read', 'blocked', '--json'])).json.result.blocked, []);
  });
});

// ---- review round 3: an escalation blocks only while the flow that raised it still consumes it; an
// exploration is "concluded" only while it has a current settle (one per opening: a rerun reopens it)

/** The first words of the mission (the add mission's request). */
const firstWords = (p: ProcessProject): string => p.ctx.memory.read((db) => (db.stmt("SELECT json_extract(record, '$.words') AS w FROM log WHERE kind = 'user.words' ORDER BY rev LIMIT 1").get() as { w: string }).w);

/** PM plan round 2 of the add mission, through Calibrator ①, the Architect (its one task under `taskId`) and Calibrator ②. */
async function replan(p: ProcessProject, mission: string, said: string, taskId: string): Promise<void> {
  const w1 = firstWords(p);
  const w2 = pmSay(p.ctx, `${said} (${mission})`).words;
  await pmPlan(p.ctx, { mission, plan: { ...(addPlan(mission, w1) as Record<string, unknown>), round: 2 }, words: [w1, w2] });
  await step(p.ctx, 'calibrator-1', (c) => cal1Pass(c));
  const dp = addDetailedPlan(mission) as { tasks: Array<Record<string, unknown>> };
  dp.tasks[0] = { ...dp.tasks[0], id: taskId, goal: `Implement add (${taskId})` };
  await step(p.ctx, 'architect-decompose', () => dp);
  await step(p.ctx, 'calibrator-2', (c) => cal2Pass(c));
}

const STABILIZE = (c: StabilizerCard) => ({ findings: c.findings.map((f) => ({ finding: f.id, verdict: 'in-scope', severity: 'serious', reason: 'checked', question: '' })), round: { verdict: 'on-track', reason: 'answers the question', question: '' } });
const RECHECK = (resolved: 'yes' | 'no') => (c: CrititorCard) => ({ findings: [], rechecks: c.priorFindings.filter((f) => f.status === 'awaiting-recheck').map((f) => ({ finding: f.id, resolved, reason: resolved === 'yes' ? 'the run covers it' : 'still there on this machine', evidence: f.disposition?.evidence !== undefined && f.disposition.evidence !== null ? [f.disposition.evidence] : [] })), settled: [], reply: 'ok' });
const REVISE = (c: AuthorCard) => ({ step: 'submit', message: 'v2', artifact: 'v2: an LFU cache', dispositions: c.openFindings.map((f) => ({ finding: f.id, action: 'revise', note: 'changed' })), directionQuestions: [], attempts: [] });

/** After the move: the rerun, then the attacker's re-check of the rebuttal on its new record. */
async function moveAndRecheck(p: ProcessProject, mission: string, resolved: 'yes' | 'no'): Promise<void> {
  p.reopen(ENV_B);
  await pmNext(p.ctx);
  // 4.1.2: reopened only on the PM's word
  await pmReopenExploration(p.ctx, { mission, exploration: 'X1' });
  await pmNext(p.ctx);
  await experiment(p);
  await pmNext(p.ctx);
  await step(p.ctx, 'crititor', RECHECK(resolved));
}

describe('review round 3: history is not current state', () => {
  const ps: ProcessProject[] = [];
  const fresh = (o: Parameters<typeof processProject>[0] = {}): ProcessProject => {
    const p = processProject(o);
    ps.push(p);
    return p;
  };
  after(() => sweepThenClean(ps));
  const PROBE = { files: { 'probe.js': "console.log('status: ok');\n" } };

  it('a re-plan drops a task while its loop-exhausted escalation is open: not blocked; the drop closes the escalation', async () => {
    const p = fresh();
    await reworksUsedUp(p);
    // a kept task with an open escalation is blocked
    const kept = await resolveSubtasks(p.ctx);
    assert.equal(kept.blocked.length, 1, brief(kept.blocked));
    assert.equal(kept.blocked[0]!.id, 'impl');
    // the user changes the approach: round 2 replaces impl with impl2
    await replan(p, 'm1', 'Drop that add task and do it fresh as a new task.', 'impl2');
    const r1 = await resolveSubtasks(p.ctx);
    const impl = r1.entries.find((e) => e.kind === 'task' && e.id === 'impl')!;
    assert.match(impl.label, /^dropped by a re-plan/);
    assert.equal(impl.blocked, null);
    assert.deepEqual(r1.blocked, [], brief(r1.blocked));
    await build(p, 9);
    await step(p.ctx, 'reviewer', (c) => reviewerPass(c));
    await pmNext(p.ctx);
    const st = await cli(p.dir, ['read', 'status', '--json', '--no-mark']);
    assert.equal(st.json.result.blocked, 0, JSON.stringify(st.json.result));
    assert.deepEqual((await cli(p.dir, ['read', 'blocked', '--json'])).json.result.blocked, []);
    // the drop closed the dropped task's escalation (code review round 9, class A): its Secretary step is
    // no longer offered, nothing waits on the user, and a late answer is refused (nothing is written)
    const nx = await pmNext(p.ctx);
    const esc = 'exh.task.m1.impl.3';
    assert.ok(!nx.ready.some((r) => r.step === `sec.${esc}`), JSON.stringify(nx.ready.map((r) => r.step)));
    assert.deepEqual(nx.waitingOnUser, []);
    const asked = await cli(p.dir, ['read', 'status', '--json', '--no-mark']);
    assert.deepEqual(asked.json.result.waitingOnUser, []);
    assert.equal(asked.json.result.blocked, 0);
    await assert.rejects(() => pmAnswer(p.ctx, { mission: 'm1', escalation: esc, option: 'abandon', words: pmSay(p.ctx, 'Give it up, it was replaced. (m1)').words }), /closed without being carried out: task impl was dropped/);
    for (let i = 0; i < 3; i++) await pmNext(p.ctx);
    const done = await cli(p.dir, ['read', 'status', '--json', '--no-mark']);
    assert.equal(done.json.result.blocked, 0);
    assert.deepEqual((await cli(p.dir, ['read', 'blocked', '--json'])).json.result.blocked, []);
  });

  it('a newer PM batch supersedes one whose Calibrator ② escalation waits on the user: not blocked, not waiting', async () => {
    const p = fresh();
    await startAddMission(p.ctx, 'm4');
    await step(p.ctx, 'calibrator-1', (c) => cal1Pass(c));
    await step(p.ctx, 'architect-decompose', () => addDetailedPlan('m4'));
    await step(p.ctx, 'calibrator-2', (c) => cal2Escalate(c, 'the user should decide the error handling'));
    await step(p.ctx, 'secretary', () => ({ option: 'ask-user', classification: 'needs-user', authorization: null, reason: 'the user decides', instructions: '', grantExtra: 0, notice: 'ask the user', mayMatter: false }));
    // while its batch is the latest, the plan's escalation is a block, and a wait of layer 0
    const before = await cli(p.dir, ['read', 'status', '--json', '--no-mark']);
    assert.equal(before.json.result.blocked, 1, JSON.stringify(before.json.result));
    assert.equal(before.json.result.waitingOnUser.length, 1);
    const bl = (await cli(p.dir, ['read', 'blocked', '--json'])).json.result.blocked as Layer1Entry[];
    assert.ok(bl.length === 1 && bl[0]!.kind === 'plan' && /^ask the user; then mp pm answer m4 /.test(bl[0]!.blocked!.next), JSON.stringify(bl));
    // the user restates the plan: round 2 passes and is built
    await replan(p, 'm4', 'Keep it simple: no error handling at all.', 'impl');
    await build(p, 1);
    await step(p.ctx, 'reviewer', (c) => reviewerPass(c));
    for (let i = 0; i < 3; i++) await pmNext(p.ctx);
    const r = await resolveSubtasks(p.ctx);
    assert.deepEqual(r.blocked, [], brief(r.blocked));
    const st = await cli(p.dir, ['read', 'status', '--json', '--no-mark']);
    assert.equal(st.json.result.blocked, 0);
    assert.deepEqual(st.json.result.waitingOnUser, []);
  });

  it('a Secretary already in flight: the next step is to wait for its hand-back (WI-28 once it is too long)', async () => {
    const p = fresh();
    await reworksUsedUp(p);
    const s = await readyOf(p.ctx, 'secretary');
    const d = pmDispatch(p.ctx, s.step);
    const r = await resolveSubtasks(p.ctx);
    assert.equal(r.blocked.length, 1, brief(r.blocked));
    assert.equal(r.blocked[0]!.blocked!.next, `the Secretary is deciding (${d.dispatch} in flight): wait for its hand-back`);
    const aged = await resolveSubtasks(later(p.ctx));
    assert.match(aged.blocked[0]!.blocked!.because, new RegExp(`dispatch ${d.dispatch} \\(secretary\\) has been in flight for`));
    assert.match(aged.blocked[0]!.blocked!.next, new RegExp(`wait for its hand-back; if its seat ended: mp pm release ${d.dispatch} --ended`));
  });

  it('reopened after a move, the re-check fails and the budget runs out: the machine stop, the conclusion only as history', async () => {
    const p = fresh(PROBE);
    await convergedOnExperiment(p, 'm2', 3);
    await moveAndRecheck(p, 'm2', 'no');
    for (let i = 0; i < 6; i++) {
      const k = (await pmNext(p.ctx)).ready[0]?.kind;
      if (k === 'stabilizer') await step(p.ctx, 'stabilizer', STABILIZE);
      else if (k === 'researcher-author') await step(p.ctx, 'researcher-author', REVISE);
      else break;
    }
    const x = (await resolveSubtasks(p.ctx)).entries.find((e) => e.kind === 'exploration' && e.id === 'X1')!;
    assert.match(x.label, /^stopped \(budget-exhausted\); concluded earlier: conclusion \(converged\), before an environment change, product negated/);
    assert.doesNotMatch(x.label, /concluded:/);
  });

  it('reopened after a move, the Stabilizer judges the round drifting and the user gives it up: settled again as no conclusion, the earlier conclusion as history', async () => {
    const p = fresh(PROBE);
    await convergedOnExperiment(p, 'm5', 3);
    await moveAndRecheck(p, 'm5', 'yes');
    await pmNext(p.ctx);
    await step(p.ctx, 'stabilizer', (c: StabilizerCard) => ({ ...STABILIZE(c), round: { verdict: 'drifting', reason: 'moved away', question: 'is the question still the same?' } }));
    await pmNext(p.ctx);
    await step(p.ctx, 'secretary', () => ({ option: 'ask-user', classification: 'needs-user', authorization: null, reason: 'the user decides', instructions: '', grantExtra: 0, notice: 'ask the user', mayMatter: false }));
    const nx = await pmNext(p.ctx);
    await pmAnswer(p.ctx, { mission: 'm5', escalation: nx.waitingOnUser[0]!.escalation, option: 'abandon', words: pmSay(p.ctx, 'Give this exploration up. (m5)').words });
    await pmNext(p.ctx);
    const x = (await resolveSubtasks(p.ctx)).entries.find((e) => e.kind === 'exploration' && e.id === 'X1')!;
    // the flow settles once per opening: the abandonment after the reopening is the current settle
    assert.match(x.label, /^concluded: no-conclusion \(budget\); replaces the conclusion recorded before an environment change: conclusion \(converged\)/);
  });

  it('reopened after a move, the re-check fails, rounds remain, it converges on a new version: concluded on the new product, the earlier conclusion as history', async () => {
    const p = fresh(PROBE);
    await convergedOnExperiment(p, 'm3', 6);
    await moveAndRecheck(p, 'm3', 'no');
    for (let i = 0; i < 12; i++) {
      const k = (await pmNext(p.ctx)).ready[0]?.kind;
      if (k === 'stabilizer') await step(p.ctx, 'stabilizer', STABILIZE);
      else if (k === 'researcher-author') await step(p.ctx, 'researcher-author', REVISE);
      else if (k === 'crititor') await step(p.ctx, 'crititor', (c: CrititorCard) => ({ findings: [], rechecks: c.priorFindings.filter((f) => f.status === 'awaiting-recheck').map((f) => ({ finding: f.id, resolved: 'yes', reason: 'fixed in v2', evidence: [] })), settled: [], reply: 'ok' }));
      else break;
    }
    const x = (await resolveSubtasks(p.ctx)).entries.find((e) => e.kind === 'exploration' && e.id === 'X1')!;
    // the re-convergence settles again (one settle per opening) on the new, proven version
    assert.match(x.label, /^concluded: conclusion \(converged\), product proven; replaces the conclusion recorded before an environment change: conclusion \(converged\), product negated/);
  });
});
