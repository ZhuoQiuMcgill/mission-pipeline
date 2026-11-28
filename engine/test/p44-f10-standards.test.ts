// 4.4 (F10, problems P10 and P12): standards that can be checked. A standard says how it is checked
// (command, reading, report, artifact, person; a 4.3 plan's reads as reading). A standard a person checks
// is never put to the Reviewer as met or not met. The Constructor's report may be cited for a standard
// checked by report, and for no other. A judgment has a fourth answer, "cannot be verified from what I
// can see", with what would be needed; a review whose only open standards are of that kind goes once to
// a decider (an escalation), not back to the Constructor, and an acceptance records each of them among
// its risks. Above `standardsWarn` standards on a task, the feasibility reviewer and the PM are told.
// The flows run on a real memory with scripted seats (test/flow-memory-fixtures.ts).

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import type { MissionId } from '../src/common/ids.ts';
import { FlowEngine } from '../src/flow/engine.ts';
import { commit, ev, flowCtx } from '../src/flow/context.ts';
import { acceptedProduct } from '../src/flow/execution.ts';
import { DetailedTask, RENEW_LINE, REVIEW_NEEDED, taskCardHash, type DetailedPlanDoc, type ReviewNeededBody } from '../src/flow/plandoc.ts';
import { recordSeatHandBack } from '../src/process/seat.ts';
import type { ProcessContext } from '../src/process/index.ts';
import type { FlowEvent, FlowTask } from '../src/flow/ports.ts';
import { submitPmBatch } from '../src/flow/planning.ts';
import { constructorDone, detailedPlan, drive, happyScript, pmPlan, secretary, seedMission, SEED_TEXT, type Script } from '../src/flow/scripted.ts';
import { escalation, secretaryOptions } from '../src/flow/secretary.ts';
import { ConfigSchema } from '../src/cli/config.ts';
import { renderSeatCard, type ConstructorCard, type ReviewerCard } from '../src/seat/card.ts';
import '../src/seat/cards/index.ts';
import { renderArchitectFeasibility, type ArchitectFeasibilityCard } from '../src/seat/cards/architect.ts';
import type { SecretaryCard } from '../src/seat/cards/secretary.ts';
import { resultProblems, type ReviewerResult } from '../src/seat/results.ts';
import { memoryPorts, say } from './flow-memory-fixtures.ts';

const M = 'm1' as MissionId;
type World = ReturnType<typeof memoryPorts>;
type Standards = DetailedPlanDoc['tasks'][number]['standards'];

/** The scripted plan with these standards on its implementation task. */
function planWith(standards: Standards): () => DetailedPlanDoc {
  return () => {
    const p = detailedPlan(M);
    return { ...p, tasks: p.tasks.map((t) => (t.id === 'impl' ? { ...t, standards } : t)) };
  };
}

async function setup(): Promise<{ ports: World; engine: FlowEngine }> {
  const ports = memoryPorts();
  say(ports, SEED_TEXT);
  await seedMission(ports, M);
  await submitPmBatch(ports, { mission: M, plan: pmPlan(M), userWords: ['W-1'], mode: 'fast' });
  return { ports, engine: new FlowEngine(ports) };
}

function withKinds(plan: () => DetailedPlanDoc, over: Record<string, Script>): Script {
  const base = happyScript(M, plan);
  return (t, s) => (Object.hasOwn(over, t.card.seat) ? (over[t.card.seat] as Script) : base)(t, s);
}

const events = async (w: World, q: { line?: string; event?: string } = {}): Promise<FlowEvent[]> => [...(await w.ledger.events({ mission: M, ...q }))] as FlowEvent[];

/** A Reviewer's hand-back: `met` per standard (a standard left out is not judged), `yes` by default. */
function judge(c: ReviewerCard, verdict: ReviewerResult['verdict'], met: Record<string, { met: ReviewerResult['judgments'][number]['met']; needed?: string; evidence?: string[] } | 'skip'> = {}): ReviewerResult {
  const ev = c.verificationRuns[0]?.evidence;
  return {
    judgments: c.standards.flatMap((s) => {
      const m = met[s.id];
      if (m === 'skip') return [];
      return [{ standard: s.id, met: m?.met ?? 'yes', reason: `judged ${s.id}`, ...(m?.needed !== undefined ? { needed: m.needed } : {}), evidence: m?.evidence ?? (ev !== undefined ? [`evidence:${ev}`] : ['file:index.ts:1']) }];
    }),
    gap_responses: c.selfReportedGaps.map((g) => ({ gap: g.id, response: 'noted' })),
    issue_responses: c.openIssues.map((i) => ({ issue: i.issue, response: 'fixed', reason: 'checked' })),
    findings: [],
    verdict,
  };
}

const KINDS: Standards = [
  { id: 'S1', text: 'Parses quoted fields', check: 'reading' },
  { id: 'S2', text: 'Unit tests pass', check: 'command' },
  { id: 'S3', text: 'A user opens a real export with it', check: 'person' },
  { id: 'S4', text: 'The hand-back states how many rows the sample has', check: 'report' },
];

describe('4.4 F10: a standard says how it is checked', () => {
  it('the cards carry the check; a person\'s standard is listed apart and never judged; the report is cited for a report standard only', async () => {
    const { ports, engine } = await setup();
    let card: ReviewerCard | null = null;
    let refused: string[] = [];
    await drive(engine, ports.scheduler, withKinds(planWith(KINDS), {
      reviewer: (t: FlowTask) => {
        const c = t.card as unknown as ReviewerCard;
        if (!c.target.includes('impl')) return { handBack: judge(c, 'pass') };
        card = c;
        // refused: a person's standard judged; the report cited for a standard read from the candidate
        refused = resultProblems(c, judge(c, 'pass', { S1: { met: 'yes', evidence: ['report'] } }), { snapshot: { lines: () => 1 } });
        return { handBack: judge(c, 'pass', { S3: 'skip', S4: { met: 'yes', evidence: ['report'] } }) };
      },
    }));
    assert.ok(card !== null);
    const c = card as ReviewerCard;
    assert.deepEqual(c.standards.map((s) => [s.id, s.check]), [['S1', 'reading'], ['S2', 'command'], ['S3', 'person'], ['S4', 'report']]);
    assert.ok(refused.includes('judgments: standard "S3" is checked by a person: it is not yours to judge; leave it out'), refused.join('\n'));
    assert.ok(refused.some((x) => x.startsWith("judgments[S1]: report: the Constructor's report is cited only for a standard checked by report")), refused.join('\n'));
    const rendered = renderSeatCard(c as never, { dispatch: 'D-x' });
    assert.ok(rendered.includes('## Acceptance standards (answer every one)\n- [S1] Parses quoted fields (check: reading)\n- [S2] Unit tests pass (check: command)\n- [S4] The hand-back states how many rows the sample has (check: report)\n'), rendered);
    assert.ok(rendered.includes('## Standards a person checks (not yours to judge: leave them out of your judgments)\n- [S3] A user opens a real export with it\n'), rendered);
    const con = ports.scheduler.card<ConstructorCard>('con.m1.impl.1');
    assert.deepEqual(con.standards.map((s) => s.check), ['reading', 'command', 'person', 'report']);
    assert.ok(renderSeatCard(con as never, { dispatch: 'D-y' }).includes('- [S3] A user opens a real export with it (check: person)'));
    // the pass with the person's standard left out is accepted: the person's standard is in the plan, readable from the task
    assert.ok((await events(ports, { line: 'task:impl' })).some((e) => e.event === 'accepted' && e.key === '1'));
  });

  it('a card without the Constructor\'s report refuses the report as evidence; the fourth answer needs no pointer but says what is needed', () => {
    const c = {
      standards: [{ id: 'S1', text: 'a', check: 'report' }, { id: 'S2', text: 'b' }],
      verificationRuns: [{ evidence: 'e1', command: 'npm test', summary: 'passed' }],
      selfReportedGaps: [], openIssues: [], materials: [],
    } as unknown as ReviewerCard;
    const r = (j: ReviewerResult['judgments']): string[] => resultProblems(c, { judgments: j, gap_responses: [], issue_responses: [], findings: [], verdict: 'needs-decision' }, { snapshot: { lines: () => 1 } });
    assert.deepEqual(r([{ standard: 'S1', met: 'yes', reason: 'stated', evidence: ['report'] }, { standard: 'S2', met: 'yes', reason: 'ran', evidence: ['evidence:e1'] }]), ['judgments[S1]: report: this card carries no Constructor\'s report to cite; if you cannot verify the standard from what you can see, answer cannot-verify']);
    assert.deepEqual(r([{ standard: 'S1', met: 'cannot-verify', reason: 'not stated', evidence: [] }, { standard: 'S2', met: 'yes', reason: 'ran', evidence: ['evidence:e1'] }]), ['judgments[S1]: cannot-verify says in "needed" what would be needed to verify it']);
    assert.deepEqual(r([{ standard: 'S1', met: 'cannot-verify', reason: 'not stated', needed: 'the row count in the hand-back', evidence: [] }, { standard: 'S2', met: 'yes', reason: 'ran', evidence: ['evidence:e1'] }]), []);
    const pass = resultProblems(c, { judgments: [{ standard: 'S1', met: 'cannot-verify', reason: 'x', needed: 'y', evidence: [] }, { standard: 'S2', met: 'yes', reason: 'ran', evidence: ['evidence:e1'] }], gap_responses: [], issue_responses: [], findings: [], verdict: 'pass' }, { snapshot: { lines: () => 1 } });
    assert.deepEqual(pass, ['verdict: "pass" leaves a standard that cannot be verified: hand back "needs-decision"; a decider settles it']);
  });

  it('a 4.3 plan (no check) reads as before: its task card is unchanged, its cards carry no check, and a 4.3-shaped review reads as 4.3 read it', async () => {
    const t = detailedPlan(M).tasks.find((x) => x.id === 'impl')!;
    const parsed = DetailedTask.parse(t);
    assert.ok(parsed.standards.every((s) => !('check' in s)), 'no check is added to a 4.3 standard');
    assert.equal(taskCardHash(t), taskCardHash(parsed), 'the card identity is the 4.3 one');
    assert.ok(!('artifacts' in parsed.verificationCommands[0]!), 'no artifacts are added to a 4.3 command');
    const { ports, engine } = await setup();
    await drive(engine, ports.scheduler, withKinds(() => detailedPlan(M), {
      reviewer: (task: FlowTask) => {
        const c = task.card as unknown as ReviewerCard;
        // the first review of impl sends it back with a 4.3-shaped judgment (no "needed"); every other passes
        return { handBack: c.target.includes('impl') && task.task === 'rev.m1.impl.1' ? judge(c, 'rework', { S1: { met: 'no' } }) : judge(c, 'pass') };
      },
    }));
    const rev = ports.scheduler.card<ReviewerCard>('rev.m1.impl.1');
    assert.ok(rev.standards.every((s) => s.check === undefined));
    // no command names artifacts, no hand-back names files: the card carries neither, and the hand-back recorded no data
    assert.ok(rev.verificationRuns.every((r) => r.artifacts === undefined) && rev.handedIn === undefined);
    assert.equal(ports.scheduler.tasks.get('con.m1.impl.1')!.handBack?.data, undefined);
    assert.ok(renderSeatCard(rev as never, { dispatch: 'D-z' }).includes('## Acceptance standards (answer every one)\n- [S1] Parses quoted fields\n- [S2] Unit tests pass\n'));
    const review = (await events(ports, { line: 'task:impl', event: 'review' })).find((e) => e.key === 'rev.m1.impl.1')!.body as Record<string, unknown>;
    assert.deepEqual(review['issues'], ['[S1] not met: judged S1']);
    assert.ok(!('unverifiable' in review), 'a review with no fourth answer carries no new field');
    assert.ok((await events(ports, { line: 'task:impl' })).some((e) => e.event === 'rework' && e.key === '2'), 'a standard not met sends the task back as before');
  });
});

describe('4.4 F10: the fourth answer goes once to a decider', () => {
  const ANSWER = { S1: { met: 'yes' as const }, S2: { met: 'cannot-verify' as const, needed: 'a run on the real device', evidence: [] } };

  it('a review whose only open standard cannot be verified raises one escalation, spends no rework, and an acceptance records the standard among its risks', async () => {
    const { ports, engine } = await setup();
    await drive(engine, ports.scheduler, withKinds(() => detailedPlan(M), {
      reviewer: (t: FlowTask) => {
        const c = t.card as unknown as ReviewerCard;
        return { handBack: c.target.includes('impl') ? judge(c, 'needs-decision', ANSWER) : judge(c, 'pass') };
      },
      secretary: () => null,
    }));
    const id = 'unv.rev.m1.impl.1';
    const e = await escalation(flowCtx(ports, M), id);
    assert.ok(e !== null, 'the escalation is keyed by the review');
    assert.equal(e.source, 'reviewer-needs-decision');
    assert.deepEqual(e.options, ['answer', 'rework', 'replan', 'accept-risk', 'ask-user'], "review p9-8: answer stays, as on every Reviewer's needs-decision");
    assert.deepEqual(e.reasons, ['[S2] cannot be verified: judged S2; needed: a run on the real device']);
    assert.deepEqual((e.facts as { unverifiable: unknown }).unverifiable, [{ standard: 'S2', reason: 'judged S2', needed: 'a run on the real device' }]);
    assert.match(e.summary, /could not verify S2 from what it can see, and nothing else is open: a decider settles it; it is not sent back to the Constructor by itself/);
    assert.match(secretaryOptions(e).find((o) => o.id === 'accept-risk')!.outcome, /each standard the Reviewer could not verify is recorded among its risks, with what would be needed/);
    assert.equal((await ports.ledger.loop('task.m1.impl', 'rework')).attempts, 0, 'no rework is spent');
    assert.ok(!(await events(ports, { line: 'task:impl' })).some((x) => x.event === 'rework'), 'it is not sent back to the Constructor');
    // the decider accepts: the standard is among the stored reasons of the acceptance, in the form of a standard not met
    await drive(engine, ports.scheduler, withKinds(() => detailedPlan(M), {
      secretary: (t: FlowTask) => ({ handBack: secretary(t.card as unknown as SecretaryCard, 'accept-risk') }),
    }));
    const acc = (await events(ports, { line: 'task:impl', event: 'accepted' })).find((x) => x.key === '1')!.body as { risks: string[]; decision: { escalation: string; option: string } };
    assert.deepEqual(acc.decision.escalation, id);
    assert.deepEqual(acc.risks, [`accepted with its risk by the Secretary on ${id}: [S2] cannot be verified: judged S2; needed: a run on the real device`]);
    // raised once: no other escalation of this review
    assert.deepEqual((await events(ports, { line: 'secretary', event: 'escalation' })).map((x) => x.key).filter((k) => k.includes('rev.m1.impl.1')), [id]);
  });

  it('sent back with instructions: the next attempt carries the standard and the instructions; a rework verdict with only that standard open is routed the same', async () => {
    const { ports, engine } = await setup();
    await drive(engine, ports.scheduler, withKinds(() => detailedPlan(M), {
      reviewer: (t: FlowTask) => {
        const c = t.card as unknown as ReviewerCard;
        return { handBack: c.target.includes('impl') && t.task === 'rev.m1.impl.1' ? judge(c, 'rework', ANSWER) : judge(c, 'pass') };
      },
      secretary: (t: FlowTask) => ({ handBack: secretary(t.card as unknown as SecretaryCard, 'rework', { instructions: 'Record the device run in the hand-back.' }) }),
    }));
    assert.ok((await escalation(flowCtx(ports, M), 'unv.rev.m1.impl.1')) !== null, 'a rework verdict whose only open standard cannot be verified goes to the decider too');
    const rw = (await events(ports, { line: 'task:impl', event: 'rework' })).find((x) => x.key === '2')!.body as { issues: string[]; instructions: string[] };
    assert.deepEqual(rw.issues, ['[S2] cannot be verified: judged S2; needed: a run on the real device']);
    assert.ok(rw.instructions.includes('Record the device run in the hand-back.'));
    const next = ports.scheduler.card<ConstructorCard>('con.m1.impl.2');
    assert.ok(next.duties.includes('[S2] cannot be verified') && next.duties.includes('Record the device run in the hand-back.'), next.duties);
    assert.ok((await events(ports, { line: 'task:impl' })).some((x) => x.event === 'accepted' && x.key === '2'));
  });

  it('a standard not met beside one that cannot be verified sends the task back as before', async () => {
    const { ports, engine } = await setup();
    await drive(engine, ports.scheduler, withKinds(() => detailedPlan(M), {
      reviewer: (t: FlowTask) => {
        const c = t.card as unknown as ReviewerCard;
        return { handBack: c.target.includes('impl') && t.task === 'rev.m1.impl.1' ? judge(c, 'rework', { S1: { met: 'no' }, S2: ANSWER.S2 }) : judge(c, 'pass') };
      },
    }));
    assert.equal(await escalation(flowCtx(ports, M), 'unv.rev.m1.impl.1'), null);
    const rw = (await events(ports, { line: 'task:impl', event: 'rework' })).find((x) => x.key === '2')!.body as { issues: string[] };
    assert.deepEqual(rw.issues, ['[S1] not met: judged S1', '[S2] cannot be verified: judged S2; needed: a run on the real device']);
    // the next Reviewer sees what the previous one could not verify
    const again = ports.scheduler.card<ReviewerCard>('rev.m1.impl.2');
    assert.deepEqual(again.previousReview?.unmet.map((u) => [u.standard, u.met]), [['S1', 'no'], ['S2', 'cannot-verify']]);
    assert.ok(renderSeatCard(again as never, { dispatch: 'D-q' }).includes('- [S2] cannot be verified: judged S2; needed: a run on the real device'));
  });
});

describe('4.4 F10: many standards on a task warn', () => {
  const many: Standards = Array.from({ length: 8 }, (_, i) => ({ id: `S${i + 1}`, text: `standard ${i + 1}` }));

  it('the PM is told once per plan version which tasks carry more than standardsWarn (7) standards; nothing is held', async () => {
    const { ports, engine } = await setup();
    await drive(engine, ports.scheduler, withKinds(planWith(many), {}));
    const told = ports.ledger.notices.filter((n) => n.category === 'many-standards');
    assert.equal(told.length, 1);
    assert.match(told[0]!.trigger, /has tasks with more than 7 standards \(standardsWarn\): impl: 8 standards/);
    assert.ok((await events(ports, { line: 'task:impl' })).some((e) => e.event === 'accepted'), 'the task goes on');
    assert.equal(ConfigSchema.safeParse({ format: 'mp41.config.v1', targetBranch: 'main', standardsWarn: 9 }).success, true);
  });

  it('the feasibility card names the tasks over the limit; a card queued before 4.4 names none', () => {
    const plan = planWith(many)();
    const card = { plan, target: 'dplan.m1.1.1', history: { gitLog: '', runs: [] }, earlierFindings: [], duties: '', constraints: [], decisionQuotes: [] } as unknown as ArchitectFeasibilityCard;
    const text = renderArchitectFeasibility({ ...card, standardsWarn: 7 });
    assert.ok(text.includes('## Tasks with more than 7 standards (standardsWarn; rework rises with their number: say whether each has a finite check)\n- impl: 8 standards\n'), text);
    assert.ok(!renderArchitectFeasibility(card).includes('standardsWarn'));
  });
});

describe('4.4 F10, review round 1', () => {
  const S2_UNVERIFIED = { S1: { met: 'yes' as const }, S2: { met: 'cannot-verify' as const, needed: 'the device log', evidence: [] } };

  it("p9-8: answer on the fourth answer's escalation: the same candidate is reviewed again with the answer, and no attempt starts", async () => {
    const { ports, engine } = await setup();
    await drive(engine, ports.scheduler, withKinds(() => detailedPlan(M), {
      reviewer: (t: FlowTask) => {
        const c = t.card as unknown as ReviewerCard;
        return { handBack: c.target.includes('impl') && t.task === 'rev.m1.impl.1' ? judge(c, 'needs-decision', S2_UNVERIFIED) : judge(c, 'pass') };
      },
      secretary: (t: FlowTask) => ({ handBack: secretary(t.card as unknown as SecretaryCard, 'answer', { instructions: 'The device log is in the hand-back folder of attempt 1.' }) }),
    }));
    const e = (await escalation(flowCtx(ports, M), 'unv.rev.m1.impl.1'))!;
    assert.match(secretaryOptions(e).find((o) => o.id === 'answer')!.outcome, /the same candidate is reviewed again with the answer on the Reviewer's card; no new attempt starts/);
    const again = ports.scheduler.card<ReviewerCard>('rev.m1.impl.1.r1');
    assert.equal(again.target, ports.scheduler.card<ReviewerCard>('rev.m1.impl.1').target, 'the same candidate');
    assert.ok(again.decisionQuotes.includes('The device log is in the hand-back folder of attempt 1.'), again.decisionQuotes.join('\n'));
    assert.ok(!(await events(ports, { line: 'task:impl' })).some((x) => x.event === 'rework'));
    assert.ok((await events(ports, { line: 'task:impl' })).some((x) => x.event === 'accepted' && x.key === '1'));
  });

  it('p9-3: an environment re-review whose only open standard cannot be verified waits for its decider, and the answer starts the next round', async () => {
    const { ports, engine } = await setup();
    await drive(engine, ports.scheduler, happyScript(M));
    const target = (await acceptedProduct(flowCtx(ports, M), 'impl'))!;
    const judgment = (await ports.evaluator.deciding([target])).views[target]!.positions.find((p) => p.review === 'reviewer')!.by!;
    const environment = ports.ctx.environment().identity;
    const ctx = flowCtx(ports, M);
    const body: ReviewNeededBody = { target, judgment, review: 'reviewer', environment, reason: 'the environment changed', rerun: null, passed: null };
    await commit(ctx, 'test:p9-3:renew', { events: [ev(ctx, RENEW_LINE, REVIEW_NEEDED, `${judgment}@${environment}`, body)] });
    await drive(engine, ports.scheduler, withKinds(() => detailedPlan(M), {
      reviewer: (t: FlowTask) => ({ handBack: t.task === 'rev.m1.impl.1.e1' ? judge(t.card as unknown as ReviewerCard, 'rework', S2_UNVERIFIED) : judge(t.card as unknown as ReviewerCard, 'pass') }),
      secretary: (t: FlowTask) => ({ handBack: secretary(t.card as unknown as SecretaryCard, 'answer', { instructions: 'The device log is kept with the run.' }) }),
    }));
    const e = (await escalation(flowCtx(ports, M), 'rnd.rev.m1.impl.1.e1'))!;
    assert.match(e.summary, /could not verify S2 from what it can see, and nothing else is open/);
    const line = await events(ports, { line: 'task:impl' });
    assert.ok(!line.some((x) => x.event === 'rework'), 'not sent back to the Constructor');
    assert.ok(ports.scheduler.tasks.has('rev.m1.impl.1.e2'), 'the answer starts the next round on the same request');
    assert.ok(line.some((x) => x.event === 'reaccepted' && x.key === '1:2'), 'and its pass re-accepts the product');
    const review = line.find((x) => x.event === 'review' && x.key === 'rev.m1.impl.1.e1')!.body as { verdict: string };
    assert.equal(review.verdict, 'rework', 'the hand-back keeps the verdict the Reviewer gave');
  });

  it('p9-1: an integration pass may not rest on its run and on data outside the commit in one judgment: that standard goes to a decider', async () => {
    const { ports, engine } = await setup();
    await drive(engine, ports.scheduler, withKinds(() => detailedPlan(M, { extraTask: true }), { reviewer: (t: FlowTask) => (t.task.startsWith('rev.m1.docs.') ? null : { handBack: judge(t.card as unknown as ReviewerCard, 'pass') }) }));
    const step = 'rev.m1.docs.1';
    const card = ports.scheduler.card<ReviewerCard>(step);
    assert.ok(card.integration !== undefined);
    const d = ports.scheduler.dispatchOf(step);
    const run = ports.scheduler.rerun(d, 'npm test');
    const dir = mkdtempSync(join(tmpdir(), 'mp-p9-1-'));
    writeFileSync(join(dir, 'sim.log'), 'ok\n');
    const pointer = `data:${join(dir, 'sim.log')}#sha256=${createHash('sha256').update('ok\n').digest('hex')}&size=3`;
    // the project declares a full suite: the integration pass rests on its full run
    const suite = { ...ports.ctx, fullSuite: [{ id: 'all', command: 'npm run all' }] } as ProcessContext;
    const both = { judgments: [{ standard: 'S1', met: 'yes' as const, reason: 'the run and the simulator agree', evidence: [`evidence:${run}`, pointer] }], gap_responses: card.selfReportedGaps.map((g) => ({ gap: g.id, response: 'noted' })), issue_responses: [], findings: [], verdict: 'pass' as const };
    const refused = await recordSeatHandBack(suite, d, { report: 'r', fields: both, advance: false });
    assert.equal(refused.kind, 'refused');
    assert.ok(refused.kind === 'refused' && refused.problems.some((x) => x.startsWith('judgments[S1]: an integration pass rests on its full run, and the hand-back is one judgment, which cannot rest on a run and on data outside the commit together: answer this standard "cannot-verify"')), JSON.stringify(refused));
    // the fourth answer keeps both pointers and goes to a decider; no pass is recorded
    const fourth = { ...both, judgments: [{ ...both.judgments[0]!, met: 'cannot-verify' as const, needed: 'a full run that writes the simulator log' }], verdict: 'needs-decision' as const };
    const a = await recordSeatHandBack(suite, d, { report: 'r', fields: fourth, advance: false });
    assert.equal(a.kind, 'recorded', JSON.stringify(a));
    await drive(engine, ports.scheduler, withKinds(() => detailedPlan(M, { extraTask: true }), { secretary: () => null }));
    const e = await escalation(flowCtx(ports, M), `unv.${step}`);
    assert.ok(e !== null && e.reasons[0]!.startsWith('[S1] cannot be verified: the run and the simulator agree; needed: a full run that writes the simulator log'), JSON.stringify(e));
    assert.ok(!(await events(ports, { line: 'task:docs' })).some((x) => x.event === 'accepted'), 'no pass is recorded');
  });
});

describe('4.4 F10, review round 2', () => {
  const S2_UNVERIFIED = { S1: { met: 'yes' as const }, S2: { met: 'cannot-verify' as const, needed: 'the device log', evidence: [] } };

  async function stableSetup(): Promise<{ ports: World; engine: FlowEngine }> {
    const ports = memoryPorts();
    say(ports, SEED_TEXT);
    await seedMission(ports, M);
    await submitPmBatch(ports, { mission: M, plan: pmPlan(M), userWords: ['W-1'], mode: 'stable' });
    return { ports, engine: new FlowEngine(ports) };
  }

  it('p9-r2-1: a rework whose only open standard cannot be verified, answered, then passed: the pass names the failure it supersedes, the product is proven and its stable dependent goes on', async () => {
    const { ports, engine } = await stableSetup();
    // the dependent cites a run of its own (as the re-bind tests' plan gives it)
    const plan = (): DetailedPlanDoc => {
      const p = detailedPlan(M, { extraTask: true });
      return { ...p, tasks: p.tasks.map((t) => (t.id === 'docs' ? { ...t, interpreter: 'node', verificationCommands: [{ id: 'lint', command: 'npx markdownlint docs/parser.md' }] } : t)) };
    };
    await drive(engine, ports.scheduler, withKinds(plan, {
      reviewer: (t: FlowTask) => ({ handBack: t.task === 'rev.m1.impl.1' ? judge(t.card as unknown as ReviewerCard, 'rework', S2_UNVERIFIED) : judge(t.card as unknown as ReviewerCard, 'pass') }),
      secretary: (t: FlowTask) => ({ handBack: secretary(t.card as unknown as SecretaryCard, 'answer', { instructions: 'The device log is kept with the run.' }) }),
    }));
    assert.ok((await escalation(flowCtx(ports, M), 'unv.rev.m1.impl.1')) !== null);
    const follow = ports.scheduler.card<ReviewerCard>('rev.m1.impl.1.r1');
    assert.equal(follow.binding.revokes, 'j.rev.m1.impl.1', 'the follow-up review names the failing judgment it supersedes');
    assert.equal(ports.scheduler.card<ReviewerCard>('rev.m1.impl.1').binding.revokes, null, 'a first review names none');
    assert.ok((await events(ports, { line: 'task:impl' })).some((x) => x.event === 'accepted' && x.key === '1'));
    assert.equal((await ports.evaluator.labels([follow.target])).labels[follow.target], 'proven', 'the evaluator holds the pass, not the earlier failure');
    assert.ok((await events(ports, { line: 'task:docs' })).some((x) => x.event === 'accepted'), 'the stable dependent goes on');
  });

  it('p9-1 (round 2): on an integration pass, a standard that rests only on data outside the commit also goes to a decider: the hand-back is one judgment', async () => {
    const plan = (): DetailedPlanDoc => {
      const p = detailedPlan(M, { extraTask: true });
      return { ...p, tasks: p.tasks.map((t) => (t.id === 'docs' ? { ...t, standards: [{ id: 'S1', text: 'A README exists' }, { id: 'S2', text: 'The simulator agrees' }] } : t)) };
    };
    const { ports, engine } = await setup();
    await drive(engine, ports.scheduler, withKinds(plan, { reviewer: (t: FlowTask) => (t.task.startsWith('rev.m1.docs.') ? null : { handBack: judge(t.card as unknown as ReviewerCard, 'pass') }) }));
    const step = 'rev.m1.docs.1';
    const card = ports.scheduler.card<ReviewerCard>(step);
    const d = ports.scheduler.dispatchOf(step);
    const run = ports.scheduler.rerun(d, 'npm test');
    const dir = mkdtempSync(join(tmpdir(), 'mp-p9-1b-'));
    writeFileSync(join(dir, 'sim.log'), 'ok\n');
    const pointer = `data:${join(dir, 'sim.log')}#sha256=${createHash('sha256').update('ok\n').digest('hex')}&size=3`;
    const suite = { ...ports.ctx, fullSuite: [{ id: 'all', command: 'npm run all' }] } as ProcessContext;
    const gaps = card.selfReportedGaps.map((g) => ({ gap: g.id, response: 'noted' }));
    const split = { judgments: [{ standard: 'S1', met: 'yes' as const, reason: 'the run', evidence: [`evidence:${run}`] }, { standard: 'S2', met: 'yes' as const, reason: 'the simulator log', evidence: [pointer] }], gap_responses: gaps, issue_responses: [], findings: [], verdict: 'pass' as const };
    const refused = await recordSeatHandBack(suite, d, { report: 'r', fields: split, advance: false });
    assert.ok(refused.kind === 'refused', JSON.stringify(refused));
    assert.deepEqual(refused.problems.filter((x) => x.includes('an integration pass rests on its full run')).map((x) => x.slice(0, 15)), ['judgments[S2]: '], 'S2, which rests only on outside data');
    const fourth = { ...split, judgments: [split.judgments[0]!, { ...split.judgments[1]!, met: 'cannot-verify' as const, needed: 'a full run that writes the log' }], verdict: 'needs-decision' as const };
    assert.equal((await recordSeatHandBack(suite, d, { report: 'r', fields: fourth, advance: false })).kind, 'recorded');
    await drive(engine, ports.scheduler, withKinds(plan, { secretary: () => null }));
    assert.ok((await escalation(flowCtx(ports, M), `unv.${step}`)) !== null, 'it goes to a decider');
  });
});
