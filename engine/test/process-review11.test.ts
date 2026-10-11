// Code review round 11 (final), real process with git, the DEFAULT label batch configuration.
// Finding 2: routing reads the explorations' proof once, at its own top: a frontier that the pass's
//   own writes finish is never routed from a read taken before them (a settled conclusion is routed
//   to the Architect, not frozen as "no conclusion"); a genuinely unproven conclusion still routes as
//   no conclusion.
// Finding 1: carrying out a decision that is not the user's is guarded, in its write, against a user
//   answer that lands after its read: the write is refused (STALE_REQUEST) and the next pass carries
//   the user's decision out; no ruling is written for the overridden decision.

import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { resolveSubtasks } from '../src/cli/layers.ts';
import type { MissionId } from '../src/common/ids.ts';
import { decisionLabels, labelBatch, labelStatus, setLabelBatchLimit } from '../src/evaluator/index.ts';
import { flowCtx } from '../src/flow/context.ts';
import { explorationState } from '../src/flow/exploration/flow.ts';
import { explorationStep } from '../src/flow/exploration/step.ts';
import { cal1Pass, cal2Escalate } from '../src/flow/scripted.ts';
import { answerEscalation, decisionFor, secretaryStep, type EscalationBody } from '../src/flow/secretary.ts';
import { pmDispatch, pmDrain, pmMission, pmNext, pmPlan, pmRequirement, pmSay } from '../src/process/index.ts';
import { dispatchView, recordSeatHandBack } from '../src/process/seat.ts';
import { seedFanout, sweepThenClean } from './exploration-exits.ts';
import { addDetailedPlan, processProject, readAll, startAddMission, step, type ProcessProject } from './process-fixtures.ts';

const X = 'X1';
const SEC = (option: string) => ({ option, classification: 'detail', authorization: null, reason: `the Secretary decides: ${option}`, instructions: '', grantExtra: 0, notice: '', mayMatter: false });
const label = (p: ProcessProject, id: string): string => String(p.ctx.memory.read((db) => decisionLabels(db, [id]))[id]);
const rulings = (p: ProcessProject): string[] => p.ctx.memory.read((db) => (db.stmt("SELECT json_extract(record, '$.judgment') AS j FROM log WHERE kind = 'judgment' AND (json_extract(record, '$.judgment') LIKE 'j.sec.%' OR json_extract(record, '$.judgment') LIKE 'j.user.%')").all() as Array<{ j: string }>).map((r) => r.j));
const planKeys = (p: ProcessProject, m: string, event: string): Array<{ key: string; body: Record<string, unknown> }> =>
  p.ctx.memory.read((db) => db.stmt("SELECT key, body FROM flow_events WHERE mission = ? AND line = 'plan' AND event = ? ORDER BY revision").all(m, event) as Array<{ key: string; body: string }>).map((r) => ({ key: r.key, body: JSON.parse(p.ctx.memory.data.text(r.body)) as Record<string, unknown> }));
const exploreEscalations = (p: ProcessProject, m: string): EscalationBody[] =>
  p.ctx.memory.read((db) => db.stmt("SELECT body FROM flow_events WHERE mission = ? AND line = 'secretary' AND event = 'escalation' AND key LIKE 'explore.%'").all(m) as Array<{ body: string }>).map((r) => JSON.parse(p.ctx.memory.data.text(r.body)) as EscalationBody);

async function handBackQuiet(p: ProcessProject, dispatch: string, fields: unknown): Promise<void> {
  readAll(p.ctx, dispatch);
  const a = await recordSeatHandBack(p.ctx, dispatch, { report: `# Report of ${dispatch}\n\nDone.\n`, fields, advance: false });
  assert.ok(a.kind === 'recorded' && a.outcome === 'accepted', JSON.stringify(a));
}

/**
 * The reviewer's scenario: an independent element e0 planned (its Calibrator ② escalated, the
 * Secretary's accept recorded but not carried out), and exploration X1 (e1 waits for it) converged
 * and settled while planning did not run. Then a fan-out and a basis update larger than a batch.
 */
async function settledWhileCal2Waits(p: ProcessProject, m: string, type: 'structure' | 'direction'): Promise<string> {
  pmMission(p.ctx, m);
  const w = pmSay(p.ctx, `Find a cache design with no obvious logical hole. Build the independent add function now. Then build the cache. The details are yours to decide. (${m})`).words;
  await pmRequirement(p.ctx, { mission: m, item: 'g1', type: 'goal', text: 'Build things', quote: 'Then build the cache', words: w });
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
        { id: 'e0', kind: 'deliverable', text: 'Independent add function', provenance: { by: 'user', words: w, quote: 'Build the independent add function now' }, after: [], items: ['g1'] },
        { id: 'x', kind: 'exploration', text: 'Design the cache', provenance: { by: 'user', words: w, quote: 'Find a cache design' }, exploration: { id: X, deliverable: 'a cache design', fuzzyGoal: { quote: 'no obvious logical hole', words: w }, attackScope: ['internal contradiction'], decision: { id: 'D1', type }, budget: { rounds: 3, micros: null }, stop: '', research: false }, after: [], items: [] },
        { id: 'e1', kind: 'deliverable', text: 'The cache, built', provenance: { by: 'user', words: w, quote: 'Then build the cache' }, after: [X], items: ['g1'] },
      ],
      goalsBeyond: [],
      authorizations: ['a1'],
    },
  });
  await step(p.ctx, 'calibrator-1', (c) => cal1Pass(c));
  const dp = addDetailedPlan(m) as { newInterfaces: Array<{ provenance: { planElement: string } }>; modules: Array<{ provenance: { planElement: string } }>; tasks: Array<{ provenance: { planElement: string } }> };
  for (const e of [...dp.newInterfaces, ...dp.modules, ...dp.tasks]) e.provenance.planElement = 'e0';
  await step(p.ctx, 'architect-decompose', () => dp);
  await step(p.ctx, 'calibrator-2', (c) => cal2Escalate(c, 'the user should decide the error handling'));
  const sec = pmDispatch(p.ctx, `sec.cal2.dplan.${m}.1.1`).dispatch;
  await handBackQuiet(p, sec, SEC('accept'));
  await secretaryStep(flowCtx(p.ctx.ports(), m as MissionId));
  // the exploration converges and settles; planning does not run meanwhile
  const ctx = (): ReturnType<typeof flowCtx> => flowCtx(p.ctx.ports(), m as MissionId);
  const fields = (kind: string, card: any): unknown =>
    kind === 'researcher-author'
      ? { step: 'submit', message: 'v1', artifact: 'v1: an LRU cache', dispositions: [], directionQuestions: [], attempts: [] }
      : kind === 'crititor'
        ? { findings: [], rechecks: [], settled: [], reply: 'assessment' }
        : { findings: card.findings.map((f: { id: string }) => ({ finding: f.id, verdict: 'in-scope', severity: 'general', reason: 'judged', question: '' })), round: { verdict: 'on-track', reason: 'answers the question', question: '' } };
  for (const kind of ['researcher-author', 'crititor', 'stabilizer', 'crititor', 'stabilizer']) {
    const task = (await explorationState(p.ctx.ports(), m as MissionId, X)).tasks;
    const queued = [...task.values()].map((q) => q.task).filter((t) => p.ctx.memory.read((db) => db.stmt("SELECT 1 FROM tasks WHERE task = ? AND state = 'queued'").get(t) !== undefined));
    assert.equal(queued.length, 1, `one queued exploration step for ${kind}: ${JSON.stringify(queued)}`);
    const d = pmDispatch(p.ctx, queued[0]!).dispatch;
    await handBackQuiet(p, d, fields(kind, dispatchView(p.ctx, d).card));
    await explorationStep(ctx());
  }
  const s = await explorationState(p.ctx.ports(), m as MissionId, X);
  assert.equal(s.settled?.body.outcome, 'conclusion');
  assert.deepEqual(planKeys(p, m, 'exploration-routed'), [], 'not routed yet');
  return s.settled!.body.artifact!;
}

/**
 * A basis update over a 2000-object fan-out, with the default batch config, pre-drained by two PM
 * batches (the reviewer's "2000 2"): the labels still recompute when `mp pm next` starts, and the
 * pass's own writes finish the frontier.
 */
async function frontierDefault(p: ProcessProject, m: string): Promise<void> {
  setLabelBatchLimit(null);
  await seedFanout(p, m, 2000);
  await p.ctx.ports().ledger.append(`update:${m}`, { records: [{ kind: 'basis.version', basisKind: 'standard', line: `common.${m}`, version: `common.${m}.v2`, mission: m, scope: null } as never] });
  for (let i = 0; i < 2; i++) labelBatch(p.ctx.memory);
  assert.equal(p.ctx.memory.read((db) => labelStatus(db)).recomputing, true);
}

/** Every label the flows read for `artifact` during the next `mp pm next`, in order. */
function observe(p: ProcessProject, artifact: string): string[] {
  const seen: string[] = [];
  const ev = p.ctx.ports().evaluator;
  const labels = ev.labels.bind(ev);
  ev.labels = async (ids) => {
    const r = await labels(ids);
    if (ids.includes(artifact)) seen.push(String(r.labels[artifact]));
    return r;
  };
  return seen;
}

describe('finding 2: routing reads the proof once, at its own top (default batches)', () => {
  const ps: ProcessProject[] = [];
  after(() => {
    setLabelBatchLimit(null);
    sweepThenClean(ps);
  });

  it('structure: a frontier the pass\'s own writes finish: routed to the Architect with X1\'s conclusion; no explore.* escalation, no Secretary step, nothing blocked', async () => {
    const p = processProject();
    ps.push(p);
    const m = 'm1';
    const artifact = await settledWhileCal2Waits(p, m, 'structure');
    await frontierDefault(p, m);
    const seen = observe(p, artifact);
    const nx = await pmNext(p.ctx);
    assert.equal(seen[0], 'recomputing', `the pass's first read saw the frontier: ${JSON.stringify(seen)}`);
    assert.ok(seen.includes('proven'), `the pass's own writes finished it: ${JSON.stringify(seen)}`);
    assert.deepEqual(planKeys(p, m, 'exploration-routed').map((e) => [e.key, e.body['route']]), [[X, 'architect']]);
    assert.ok(planKeys(p, m, 'attempt').some((e) => (e.body['conclusions'] as Array<{ exploration: string }>).some((c) => c.exploration === X)), JSON.stringify(planKeys(p, m, 'attempt')));
    assert.deepEqual(exploreEscalations(p, m), []);
    const after2 = await pmNext(p.ctx);
    assert.ok(![...nx.ready, ...after2.ready].some((r) => r.kind === 'secretary'), JSON.stringify(after2.ready.map((r) => r.step)));
    assert.deepEqual((await resolveSubtasks(p.ctx)).blocked, []);
  });

  it('direction: the same frontier: exactly one explore.* escalation, a conclusion, options accept and ask-user', async () => {
    const p = processProject();
    ps.push(p);
    const m = 'm2';
    const artifact = await settledWhileCal2Waits(p, m, 'direction');
    await frontierDefault(p, m);
    const seen = observe(p, artifact);
    await pmNext(p.ctx);
    assert.equal(seen[0], 'recomputing', JSON.stringify(seen));
    assert.ok(seen.includes('proven'), JSON.stringify(seen));
    await pmNext(p.ctx);
    const esc = exploreEscalations(p, m);
    assert.equal(esc.length, 1, JSON.stringify(esc.map((e) => e.id)));
    assert.equal((esc[0]!.facts as { outcome: string }).outcome, 'conclusion');
    assert.deepEqual(esc[0]!.options, ['accept', 'ask-user']);
  });

  it('a genuinely unproven conclusion (its final label negated) still routes as no conclusion, with replan and ask-user', async () => {
    const p = processProject();
    ps.push(p);
    const m = 'm3';
    const artifact = await settledWhileCal2Waits(p, m, 'structure');
    const c = p.ctx.ports().ledger.content;
    await p.ctx.ports().ledger.append('negate', { records: [{ kind: 'judgment', judgment: 'j.x1.fail' as never, review: 'crititor', executor: 'crititor', target: artifact as never, verdict: 'fail', evidence: c.putList([]), bases: c.putList([]), constraints: c.putList([]), reliesOn: c.putList([]), issues: [], revokes: null, evidenceUse: { fields: [], statisticalOrExternal: false }, superseded: [], extends: null }] });
    await frontierDefault(p, m);
    const seen = observe(p, artifact);
    await pmNext(p.ctx);
    assert.equal(seen[0], 'recomputing', JSON.stringify(seen));
    await pmNext(p.ctx);
    assert.equal(label(p, artifact), 'negated');
    const esc = exploreEscalations(p, m);
    assert.equal(esc.length, 1, JSON.stringify(esc.map((e) => e.id)));
    assert.equal((esc[0]!.facts as { outcome: string }).outcome, 'no-conclusion');
    assert.deepEqual(esc[0]!.options, ['replan', 'ask-user']);
  });
});

describe('finding 1: a user answer that lands after the read and before the write of carrying out the Secretary\'s decision', () => {
  const ps: ProcessProject[] = [];
  after(() => {
    setLabelBatchLimit(null);
    sweepThenClean(ps);
  });

  for (const frontier of [false, true]) {
    it(`the user's send-back wins: the write is refused, no ruling, the plan still negated; the next pass carries out the send-back${frontier ? ' (during a frontier: the wider window)' : ''}`, async () => {
      const p = processProject();
      ps.push(p);
      const m = frontier ? 'm5' : 'm4';
      const esc = `cal2.dplan.${m}.1.1`;
      await startAddMission(p.ctx, m);
      await step(p.ctx, 'calibrator-1', (c) => cal1Pass(c));
      await step(p.ctx, 'architect-decompose', () => addDetailedPlan(m));
      await step(p.ctx, 'calibrator-2', (c) => cal2Escalate(c, 'the user should decide the error handling'));
      const sec = pmDispatch(p.ctx, `sec.${esc}`).dispatch;
      await handBackQuiet(p, sec, SEC('accept'));
      await secretaryStep(flowCtx(p.ctx.ports(), m as MissionId));
      if (frontier) {
            await frontierDefault(p, m);
      }
      // a second process: the PM's `mp pm answer` commits between carryOut's read and its guarded write
      const words = pmSay(p.ctx, `Send it back and describe the errors. (${m})`).words;
      const ledger = p.ctx.ports().ledger;
      const append = ledger.append.bind(ledger);
      let injected = false;
      ledger.append = async (op, entries) => {
        if (!injected && op === `flow:applied:${m}:${esc}`) {
          injected = true;
          await answerEscalation(p.ctx.ports(), { mission: m as MissionId, escalation: esc, option: 'send-back', instructions: 'describe the errors', words: `Send it back and describe the errors. (${words})` });
        }
        return append(op, entries);
      };
      const first = await pmNext(p.ctx);
      assert.equal(injected, true);
      assert.ok(first.errors.some((e) => /answered/.test(e)), `the guarded write is refused: ${JSON.stringify(first.errors)}`);
      ledger.append = append;
      assert.deepEqual(rulings(p), [], 'no ruling for the overridden decision');
      await pmNext(p.ctx);
      const a = p.ctx.memory.read((db) => db.stmt("SELECT body FROM flow_events WHERE mission = ? AND line = 'secretary' AND event = 'applied' AND key = ?").get(m, esc) as { body: string } | undefined);
      const body = a === undefined ? null : (JSON.parse(p.ctx.memory.data.text(a.body)) as { what?: { option?: string }; by?: string });
      assert.deepEqual([body?.what?.option, body?.by], ['send-back', 'user'], 'the user\'s decision carried out');
      assert.equal((await decisionFor(flowCtx(p.ctx.ports(), m as MissionId), esc))?.option, 'send-back');
      assert.deepEqual(rulings(p), []);
      if (frontier) pmDrain(p.ctx);
      assert.equal(label(p, `dplan.${m}.1.1`), 'negated');
      assert.deepEqual(planKeys(p, m, 'effective'), [], 'the sent-back plan is not in effect');
    });
  }
});
