// 4.1 process behaviours whose 4.0 tests went with the 4.0 code (package A6's review), and the
// execution routing after an ordinary basis revision (v51 §4.1, the maintainer's fast/stable
// modes; design 4.1 §6.2), ported from the 4.0 scheduler's routing into the execution flow:
//   stable mode: an accepted result whose basis got a new version is re-accepted on it (a Reviewer
//   for the same candidate and position); fast mode: it goes on, "not fully proven" (a notice).

import assert from 'node:assert/strict';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import type { MissionId, ObjectVersionId } from '../src/common/ids.ts';
import { decisionLabels } from '../src/evaluator/index.ts';
import { cal1Pass, cal2Pass, feasible } from '../src/flow/scripted.ts';
import { pmDispatch, pmMission, pmNext, pmPlan, pmRequirement, pmSay } from '../src/process/index.ts';
import { dispatchView } from '../src/process/seat.ts';
import type { ReviewerCard } from '../src/seat/card.ts';
import { addDetailedPlan, addMissionToReview, addPlan, CHECK_JS, handBack, processProject, readAll, readyOf, reviewerPass, step, write, type ProcessProject } from './process-fixtures.ts';

const M = 'm1' as MissionId;
const PRODUCT = `prod.con.${M}.impl.1` as ObjectVersionId;
let p: ProcessProject | null = null;
afterEach(() => {
  p?.cleanup();
  p = null;
});

const label = (pp: ProcessProject, id: string) => pp.ctx.memory.read((db) => decisionLabels(db, [id]))[id];

/** The add mission to an accepted product, in the plan's mode. */
async function accepted(mode: 'stable' | 'fast'): Promise<ProcessProject> {
  const pp = processProject();
  const ctx = pp.ctx;
  if (mode === 'stable') {
    await addMissionToReview(pp, M);
  } else {
    pmMission(ctx, M);
    const w = pmSay(ctx, `Please write an add function, with a check that it works. The details are yours to decide. (${M})`).words;
    await pmRequirement(ctx, { mission: M, item: 'g1', type: 'goal', text: 'An add function', quote: 'an add function', words: w });
    await pmRequirement(ctx, { mission: M, item: 'a1', type: 'authorization', text: 'Details are the PM\'s', quote: 'The details are yours to decide', words: w });
    await pmPlan(ctx, { mission: M, plan: addPlan(M, w), words: [w], mode: 'fast' });
    await step(ctx, 'calibrator-1', (c) => cal1Pass(c));
    await step(ctx, 'architect-decompose', () => addDetailedPlan(M));
    await step(ctx, 'calibrator-2', (c) => cal2Pass(c));
    const s = await readyOf(ctx, 'constructor');
    const d = pmDispatch(ctx, s.step);
    write(join(pp.dir, d.worktree!), 'src/add.js', 'exports.add = (a, b) => a + b;\n');
    write(join(pp.dir, d.worktree!), 'src/check.js', CHECK_JS);
    await handBack(ctx, d.dispatch, { done: 'implemented add', unmet_standards: [], unfixed_problems: [], decisions_needed: [] });
  }
  await step(ctx, 'reviewer', (c) => reviewerPass(c));
  await pmNext(ctx);
  assert.equal(label(pp, PRODUCT), 'proven');
  return pp;
}

/** An ordinary revision of the requirement item the product's review is bound to. */
async function reviseGoal(pp: ProcessProject): Promise<void> {
  const w = pmSay(pp.ctx, 'The add function should also accept negative numbers.').words;
  await pmRequirement(pp.ctx, { mission: M, item: 'g1', type: 'goal', text: 'An add function that also accepts negative numbers', quote: 'accept negative numbers', words: w });
}

describe('routing after an ordinary basis revision (v51 §4.1, design 4.1 §6.2)', () => {
  it('stable mode: the accepted result is re-accepted on the new basis by a Reviewer of the same candidate and position', async () => {
    p = await accepted('stable');
    const ctx = p.ctx;
    await reviseGoal(p);
    assert.equal(label(p, PRODUCT), 'not-fully-proven', 'never rejected: the label degrades');
    const next = await pmNext(ctx);
    const rev = next.ready.find((r) => r.kind === 'reviewer');
    assert.ok(rev, `a re-acceptance step: ${next.ready.map((r) => r.kind).join(', ')}`);
    const d = pmDispatch(ctx, rev.step);
    readAll(ctx, d.dispatch);
    const card = dispatchView(ctx, d.dispatch).card as unknown as ReviewerCard;
    assert.equal(card.target, PRODUCT, 'the same candidate');
    assert.equal(card.review, 'reviewer');
    assert.match(card.duties, /a basis has a new version/);
    const a = await handBack(ctx, d.dispatch, reviewerPass(card));
    assert.ok(a.kind === 'recorded' && a.outcome === 'accepted');
    await pmNext(ctx);
    // the new judgment of the same position is bound to the new version of the item
    const j = ctx.memory.read((db) => JSON.parse((db.stmt("SELECT record FROM log WHERE kind = 'judgment' AND json_extract(record, '$.judgment') = ?").get(`j.${rev.step}`) as { record: string }).record) as { target: string; review: string; bases: { hash: string; count: number } });
    assert.deepEqual([j.target, j.review], [PRODUCT, 'reviewer']);
    const bases = ctx.memory.data.getList(j.bases as never);
    const item = ctx.memory.read((db) => (db.stmt("SELECT json_extract(record, '$.version') AS v FROM log WHERE kind = 'basis.version' AND json_extract(record, '$.line') = ? ORDER BY rev DESC LIMIT 1").get(`item.${M}.g1`) as { v: string }).v);
    assert.ok(bases.includes(item), `bound to ${item}: ${bases.join(', ')}`);
    // (its label also waits for the decision layer to re-check the plan against the revised item: the plan relies on it)
    assert.equal((await pmNext(ctx)).ready.filter((r) => r.kind === 'reviewer').length, 0, 're-accepted once');
  });

  it('fast mode: it goes on, the product "not fully proven", and the PM is told', async () => {
    p = await accepted('fast');
    const ctx = p.ctx;
    await reviseGoal(p);
    const next = await pmNext(ctx);
    assert.equal(next.ready.filter((r) => r.kind === 'reviewer').length, 0, 'no re-acceptance in fast mode');
    assert.equal(label(p, PRODUCT), 'not-fully-proven');
    assert.ok(next.notices.some((n) => n.category === 'result-not-fully-proven' && n.wi === null), next.notices.map((n) => n.category).join(', '));
  });
});

// ---------------------------------------------------------------- behaviours whose 4.0 tests went with the 4.0 code

/** A detailed plan of the add mission's element e1 with the given tasks (each with its own check). */
function planOf(tasks: Array<{ id: string; kind: 'implementation' | 'integration' | 'experiment'; dir: string; exclusive?: string[]; dependsOn?: string[]; implementsAdd?: boolean; readOnly?: boolean; writeScope?: string[] }>): unknown {
  return {
    reusedInterfaces: [],
    newInterfaces: [{ name: 'add', definition: 'add(a: number, b: number): number', searched: 'searched the repository: no arithmetic helpers exist', provenance: { planElement: 'e1' } }],
    modules: [{ id: 'core', writeScope: tasks.filter((t) => t.readOnly !== true).map((t) => `${t.dir}/**`), provenance: { planElement: 'e1' } }],
    tasks: tasks.map((t) => ({
      id: t.id,
      kind: t.kind,
      module: t.readOnly === true ? null : 'core',
      goal: t.readOnly === true ? `Run the checks of ${t.dir}/ (read-only: make no edits)` : `Task ${t.id}`,
      standards: [{ id: 'S1', text: 'its check passes' }],
      requirementItems: [`item.${M}.g1`],
      writeScope: t.writeScope ?? (t.readOnly === true ? [] : [`${t.dir}/**`]),
      readableFiles: ['README.md'],
      interpreter: 'node',
      verificationCommands: [{ id: 'check', command: `node ${t.dir}/check.js` }],
      implements: t.implementsAdd === true ? ['add'] : [],
      calls: [],
      dependsOn: t.dependsOn ?? [],
      exclusive: t.exclusive ?? [],
      estimate: { durationMs: 60_000, costMicros: 100_000, basis: 'small' },
      provenance: { planElement: 'e1' },
    })),
    risks: [],
  };
}

async function planned(detailed: unknown): Promise<ProcessProject> {
  const { startAddMission } = await import('./process-fixtures.ts');
  const pp = processProject();
  await startAddMission(pp.ctx, M);
  await step(pp.ctx, 'calibrator-1', (c) => cal1Pass(c));
  await step(pp.ctx, 'architect-decompose', () => detailed);
  // a plan of more than one task gets the Architect's feasibility review (3.6)
  if ((await pmNext(pp.ctx)).ready.some((r) => r.kind === 'architect-feasibility')) await step(pp.ctx, 'architect-feasibility', () => feasible());
  await step(pp.ctx, 'calibrator-2', (c) => cal2Pass(c));
  return pp;
}

/** Build a task's files in its worktree and hand back (its check passes unless told otherwise). */
async function construct(pp: ProcessProject, step0: string, dir: string, o: { failing?: boolean } = {}) {
  const d = pmDispatch(pp.ctx, step0);
  write(join(pp.dir, d.worktree!), `${dir}/add.js`, 'exports.add = (a, b) => a + b;\n');
  write(join(pp.dir, d.worktree!), `${dir}/check.js`, o.failing === true ? "console.log('not ok 1 - adds'); process.exit(1);\n" : "console.log('ok 1 - adds'); process.exit(0);\n");
  const a = await handBack(pp.ctx, d.dispatch, { done: 'done', unmet_standards: [], unfixed_problems: [], decisions_needed: [] });
  if (a.kind !== 'recorded') throw new Error(JSON.stringify(a));
  return { dispatch: d.dispatch, answer: a };
}

describe('mp pm next: priority order, the parallel flag, leases (§5.1, §6.2)', () => {
  it('steps sharing an exclusive resource are not parallel; a dispatch leases it and holds the other; a Reviewer outranks a Constructor', async () => {
    p = await planned(planOf([
      { id: 'ta', kind: 'implementation', dir: 'a', exclusive: ['db'], implementsAdd: true },
      { id: 'tb', kind: 'experiment', dir: 'b', exclusive: ['db'] },
      { id: 'tc', kind: 'experiment', dir: 'c' },
    ]));
    const ctx = p.ctx;
    let next = await pmNext(ctx);
    const by = (task: string) => next.ready.find((r) => r.step.includes(`.${task}.`));
    assert.deepEqual(next.ready.map((r) => r.kind), ['constructor', 'constructor', 'constructor']);
    assert.equal(by('ta')?.parallel, false, 'shares the db with tb');
    assert.equal(by('tb')?.parallel, false);
    assert.equal(by('tc')?.parallel, true, 'no shared write path or resource');
    await construct(p, by('ta')!.step, 'a');
    next = await pmNext(ctx);
    // ta handed back: its lease is free again; its Reviewer (priority 60) comes before the Constructors (50)
    assert.equal(next.ready[0]?.kind, 'reviewer');
    assert.ok(next.ready.slice(1).every((r) => r.kind === 'constructor'));
    // a dispatch holds the lease while it is in flight
    const tb = next.ready.find((r) => r.step.includes('.tb.'))!;
    pmDispatch(ctx, tb.step);
    next = await pmNext(ctx);
    assert.equal(next.inFlight.some((d) => d.step === tb.step), true);
    const tcReady = next.ready.find((r) => r.step.includes('.tc.'));
    assert.ok(tcReady !== undefined && tcReady.parallel, 'tc still runs alongside');
  });

  it('a second step needing the leased resource is held while the first is in flight', async () => {
    p = await planned(planOf([
      { id: 'ta', kind: 'implementation', dir: 'a', exclusive: ['db'], implementsAdd: true },
      { id: 'tb', kind: 'experiment', dir: 'b', exclusive: ['db'] },
    ]));
    const ctx = p.ctx;
    let next = await pmNext(ctx);
    const ta = next.ready.find((r) => r.step.includes('.ta.'))!;
    const d = pmDispatch(ctx, ta.step);
    next = await pmNext(ctx);
    const held = next.held.find((h) => h.step.includes('.tb.'));
    assert.ok(held !== undefined, `held: ${JSON.stringify(next.held)}`);
    assert.match(held.why, new RegExp(`waits for db \\(leased to ${d.dispatch}\\)`));
    write(join(p.dir, d.worktree!), 'a/add.js', 'exports.add = (a, b) => a + b;\n');
    write(join(p.dir, d.worktree!), 'a/check.js', "console.log('ok 1 - adds');\n");
    await handBack(ctx, d.dispatch, { done: 'done', unmet_standards: [], unfixed_problems: [], decisions_needed: [] });
    next = await pmNext(ctx);
    assert.ok(next.ready.some((r) => r.step.includes('.tb.')), 'released with the hand-back: ready again');
  });
});

describe('execution: a dependent task\'s snapshot, a failing verification run', () => {
  it('a dependent task\'s Constructor works on its dependency\'s accepted product laid over the base', async () => {
    p = await planned(planOf([
      { id: 'ta', kind: 'implementation', dir: 'a', implementsAdd: true },
      { id: 'td', kind: 'integration', dir: 'd', dependsOn: ['ta'] },
    ]));
    const ctx = p.ctx;
    await construct(p, (await readyOf(ctx, 'constructor')).step, 'a');
    await step(ctx, 'reviewer', (c) => reviewerPass(c));
    const s = await readyOf(ctx, 'constructor');
    assert.match(s.step, /\.td\./);
    const d = pmDispatch(ctx, s.step);
    const snap = (dispatchView(ctx, d.dispatch).card as unknown as { workspace: { snapshot: string } }).workspace.snapshot;
    assert.notEqual(snap, p.git('rev-parse', 'HEAD'), 'not the bare base');
    assert.equal(p.git('show', `${snap}:a/add.js`), 'exports.add = (a, b) => a + b;', 'the accepted product is in the snapshot');
    assert.equal(p.git('-C', join(p.dir, d.worktree!), 'show', 'HEAD:a/check.js').includes('ok 1'), true, 'and in the worktree');
  });

  it('a failing verification run is kept as evidence and shown to the Reviewer', async () => {
    p = await planned(planOf([{ id: 'ta', kind: 'implementation', dir: 'a', implementsAdd: true }]));
    const ctx = p.ctx;
    const c = await construct(p, (await readyOf(ctx, 'constructor')).step, 'a', { failing: true });
    assert.ok(c.answer.kind === 'recorded' && c.answer.verification !== null && c.answer.verification.length === 1);
    const run = c.answer.kind === 'recorded' ? c.answer.verification![0]! : null;
    assert.equal(run?.passed, false);
    const rec = ctx.memory.read((db) => JSON.parse((db.stmt("SELECT record FROM log WHERE kind = 'evidence' AND json_extract(record, '$.evidence') = ?").get(run!.evidence) as { record: string }).record) as { fields: Record<string, string>; runClass: string });
    assert.equal(rec.fields['exit'], '1');
    assert.equal(rec.fields['test:adds'], 'failed');
    assert.equal(rec.runClass, 'declared');
    const s = await readyOf(ctx, 'reviewer');
    const d = pmDispatch(ctx, s.step);
    const card = dispatchView(ctx, d.dispatch).card as unknown as ReviewerCard;
    assert.equal(card.verificationRuns[0]?.evidence, run!.evidence);
    assert.match(card.verificationRuns[0]!.summary, /exit 1/);
  });
});

describe('stops, notices, the Secretary\'s re-dispatches', () => {
  it('steps held by a stop run again once it is released', async () => {
    const { pmStop } = await import('../src/process/index.ts');
    const { releaseStop } = await import('../src/memory/index.ts');
    const { startAddMission } = await import('./process-fixtures.ts');
    p = processProject();
    const ctx = p.ctx;
    await startAddMission(ctx, M);
    pmStop(ctx, { stop: 'stop-1' as never, scope: { kind: 'mission', mission: M }, words: 'stop m1', wordsEntry: null });
    let next = await pmNext(ctx);
    assert.equal(next.ready.length, 0);
    assert.ok(next.held.some((h) => h.kind === 'calibrator-1' && /a stop covers it/.test(h.why)));
    ctx.memory.write({ op: 'release:stop-1', payload: {}, stop: true }, (tx) => releaseStop(tx, 'stop-1' as never));
    next = await pmNext(ctx);
    assert.deepEqual(next.ready.map((r) => r.kind), ['calibrator-1'], 'the held step is ready again');
    assert.equal(next.held.length, 0);
  });

  it('notices: undelivered first and marked delivered when shown; acknowledged ones are not shown again', async () => {
    const { pmAck } = await import('../src/process/index.ts');
    const { cal1Fail } = await import('../src/flow/scripted.ts');
    const { startAddMission } = await import('./process-fixtures.ts');
    p = processProject();
    const ctx = p.ctx;
    await startAddMission(ctx, M);
    await step(ctx, 'calibrator-1', (c) => cal1Fail(c, 'e1', 'ask-user'));
    const first = await pmNext(ctx);
    assert.ok(first.notices.length > 0);
    assert.ok(first.notices.every((n) => n.state === 'undelivered'), 'shown for the first time');
    const second = await pmNext(ctx);
    assert.ok(second.notices.every((n) => n.state === 'delivered'), 'shown again until acknowledged, marked delivered');
    assert.deepEqual(pmAck(ctx, second.notices.map((n) => n.id)), { acknowledged: second.notices.length });
    const third = await pmNext(ctx);
    assert.deepEqual(third.notices, [], 'acknowledged: not shown again');
  });

  it('a Secretary dispatch released counts on the lineage it handles (6.5); used up, the decision goes to the user (WI-24)', async () => {
    const { pmRelease } = await import('../src/process/index.ts');
    const { loopState } = await import('../src/memory/index.ts');
    const { reviewer } = await import('../src/flow/scripted.ts');
    p = await planned(planOf([{ id: 'ta', kind: 'implementation', dir: 'a', implementsAdd: true }]));
    const ctx = p.ctx;
    await construct(p, (await readyOf(ctx, 'constructor')).step, 'a');
    await step(ctx, 'reviewer', (c) => reviewer(c, 'needs-decision'));
    const sec = await readyOf(ctx, 'secretary');
    const lineage = ctx.memory.read((db) => (db.stmt('SELECT lineage FROM tasks WHERE task = ?').get(sec.step) as { lineage: string }).lineage);
    assert.match(lineage, /^task\./, 'the Secretary runs in the task lineage it handles');
    for (let i = 1; i <= 2; i++) {
      const d = pmDispatch(ctx, (await readyOf(ctx, 'secretary')).step);
      const r = await pmRelease(ctx, d.dispatch, 'abandoned');
      assert.equal(r.requeued, true);
      assert.equal(ctx.memory.read((db) => loopState(db, lineage, 'quarantine-restart')).attempts, i);
    }
    const d3 = pmDispatch(ctx, (await readyOf(ctx, 'secretary')).step);
    const r3 = await pmRelease(ctx, d3.dispatch, 'abandoned');
    assert.equal(r3.exhausted, true, 'its re-dispatches are used up');
    // no Secretary decides for the Secretary: the escalation goes to the user (WI-24)
    const next = await pmNext(ctx);
    assert.ok(next.notices.some((n) => n.category === 'secretary-undecided' && n.wi === 'WI-24'), next.notices.map((n) => `${n.category}/${n.wi}`).join(', '));
    assert.equal(next.ready.filter((r) => r.kind === 'secretary').length, 0);
  });
});

describe('a task that only reads and runs (the real two-harness run: an "integrate-tests" task)', () => {
  it('4.1.2: an integration task with an empty write scope gets no Constructor; its start snapshot is its candidate, claims no path; delivering both outputs succeeds and lands', async () => {
    const { pmDeliver, pmLand } = await import('../src/process/index.ts');
    p = await planned(planOf([
      { id: 'impl', kind: 'implementation', dir: 'a', implementsAdd: true },
      { id: 'tests', kind: 'integration', dir: 'a', dependsOn: ['impl'], readOnly: true },
    ]));
    const ctx = p.ctx;
    await construct(p, (await readyOf(ctx, 'constructor')).step, 'a');
    await step(ctx, 'reviewer', (c) => reviewerPass(c));
    // nothing to write, so no Constructor: the program records the start snapshot (the dependencies'
    // products laid over the base, on real git) as the product, and its Reviewer is ready at once
    const next = await pmNext(ctx);
    assert.ok(!next.ready.some((r) => r.kind === 'constructor'), `no Constructor step: ${next.ready.map((r) => r.step).join(', ')}`);
    const s = await readyOf(ctx, 'reviewer');
    assert.match(s.step, /\.tests\./);
    await step(ctx, 'reviewer', (c) => {
      assert.equal(c.integration?.hasConstructor, false, 'the Reviewer card says no Constructor ran');
      assert.deepEqual(c.candidate.changedPaths, []);
      assert.deepEqual(c.integration?.dependencies.map((x: { task: string }) => x.task), ['impl']);
      return reviewerPass(c);
    });
    const testsProduct = `prod.con.${M}.tests.1`;
    const implProduct = `prod.con.${M}.impl.1`;
    const rec = ctx.memory.read((db) => JSON.parse((db.stmt("SELECT record FROM log WHERE kind = 'object.version' AND json_extract(record, '$.object') = ?").get(testsProduct) as { record: string }).record) as { scope: { paths: string[] }; source: { writeScope: string[] }; prerequisites: unknown });
    assert.deepEqual(rec.scope.paths, [], 'it claims no path');
    assert.deepEqual(rec.source.writeScope, []);
    assert.deepEqual(ctx.memory.data.getList(rec.prerequisites as never), [implProduct], 'its start is pinned to its dependency\'s product');
    await pmNext(ctx);
    assert.equal(label(p, testsProduct), 'proven');
    // the reviewer's repro: delivering both outputs, or only the read-only one, is not "incompatible"
    const words = pmSay(ctx, 'Deliver it to main.').words;
    const onlyTests = await pmDeliver(ctx, { mission: M, delivery: 'v0', selected: [{ kind: 'object', id: testsProduct as never }], words });
    assert.equal(onlyTests.kind, 'delivered', `selecting only the read-only output delivers its prerequisite: ${JSON.stringify(onlyTests).slice(0, 400)}`);
    const both = await pmDeliver(ctx, { mission: M, delivery: 'v1', selected: [{ kind: 'object', id: implProduct as never }, { kind: 'object', id: testsProduct as never }], words });
    assert.equal(both.kind, 'delivered', JSON.stringify(both).slice(0, 400));
    if (both.kind !== 'delivered') return;
    // the start snapshot is the integration product's origin: its start holds its dependencies' unlanded work
    assert.deepEqual(both.record.proof?.notFullyProven, []);
    const landed = await pmLand(ctx, { mission: M, delivery: 'v1', words });
    assert.equal(landed.kind, 'landed', JSON.stringify(landed).slice(0, 400));
    assert.equal(p.git('show', 'refs/heads/main:a/add.js'), 'exports.add = (a, b) => a + b;');
  });
});

describe('the real run\'s exact plan: a read-only task that still declared a write path', () => {
  it('its first attempt changed nothing of its base: the product claims no path, and the delivery of both outputs succeeds', async () => {
    const { pmDeliver } = await import('../src/process/index.ts');
    p = await planned(planOf([
      { id: 'impl', kind: 'implementation', dir: 'a', implementsAdd: true },
      { id: 'tests', kind: 'integration', dir: 'a', dependsOn: ['impl'], readOnly: true, writeScope: ['a/add.js'] },
    ]));
    const ctx = p.ctx;
    await construct(p, (await readyOf(ctx, 'constructor')).step, 'a');
    await step(ctx, 'reviewer', (c) => reviewerPass(c));
    const d = pmDispatch(ctx, (await readyOf(ctx, 'constructor')).step);
    const ok = await handBack(ctx, d.dispatch, { done: 'ran the tests: they pass', unmet_standards: [], unfixed_problems: [], decisions_needed: [] });
    assert.ok(ok.kind === 'recorded' && ok.outcome === 'accepted', JSON.stringify(ok));
    await step(ctx, 'reviewer', (c) => reviewerPass(c));
    const testsProduct = `prod.con.${M}.tests.1`;
    const rec = ctx.memory.read((db) => JSON.parse((db.stmt("SELECT record FROM log WHERE kind = 'object.version' AND json_extract(record, '$.object') = ?").get(testsProduct) as { record: string }).record) as { scope: { paths: string[] } });
    assert.deepEqual(rec.scope.paths, [], 'no claim on a/add.js, which its dependency\'s product holds (the real run claimed it: "1 path in different versions")');
    await pmNext(ctx);
    const words = pmSay(ctx, 'Deliver it to main.').words;
    const both = await pmDeliver(ctx, { mission: M, delivery: 'v1', selected: [{ kind: 'object', id: `prod.con.${M}.impl.1` as never }, { kind: 'object', id: testsProduct as never }], words });
    assert.equal(both.kind, 'delivered', JSON.stringify(both).slice(0, 400));
  });
});
