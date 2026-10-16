// A later attempt starts from its dependencies' current work (design 4.1 Appendix M).
//
// A rework under the same, unchanged card continues in a worktree at the previous attempt's
// candidate. When the task's dependencies changed since its work began (a re-plan added one, or
// one was accepted again at a newer version), the next attempt starts from the snapshot a first
// attempt would get now with the previous version's whole change laid over it, and that snapshot
// is its product's origin. With no change of its dependencies it continues from the previous
// candidate exactly as before. A carried change that conflicts with the new snapshot builds
// nothing: the attempt waits with a notice, and a re-plan of its card starts it afresh.
//
// The scenario: base → impl → use (impl in lib/, use integrates); a re-plan adds `extra` as a
// dependency of impl (in its own module, or on a file of impl's write scope).

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import type { MissionId, ObjectVersionId } from '../src/common/ids.ts';
import type { ObjectVersionRecord } from '../src/common/records.ts';
import { cal1Pass, cal2Pass, feasible } from '../src/flow/scripted.ts';
import { factById } from '../src/memory/index.ts';
import { pmDeliver, pmDispatch, pmNext, pmPlan, pmSay } from '../src/process/index.ts';
import { dispatchView } from '../src/process/seat.ts';
import type { ReviewerCard } from '../src/seat/card.ts';
import { addPlan, handBack, processProject, readAll, reviewerPass, startAddMission, step, write, type ProcessProject } from './process-fixtures.ts';

const M = 'm1' as MissionId;
const prod = (task: string, k: number): ObjectVersionId => `prod.con.${M}.${task}.${k}` as ObjectVersionId;

let p: ProcessProject | null = null;
afterEach(() => {
  const q = p;
  p = null;
  q?.cleanup();
});

const BASE_FILES: Record<string, string> = {
  'check.js': "console.log('TAP version 13');\nconsole.log('ok 1 - fine');\n",
  'core/x.txt': 'x0\n',
  'lib/a.txt': 'a0\n',
  'lib/b.txt': 'b0\n',
  'lib/common.txt': 'common0\n',
  'app/main.txt': 'main0\n',
};
const PATHS = ['core/x.txt', 'ext/e.txt', 'lib/a.txt', 'lib/b.txt', 'lib/common.txt'];

/** extra: none (round 1), in its own module ext/, or on lib/common.txt (a file of impl's write scope). */
function plan(o: { extra?: 'ext' | 'common'; baseGoal?: string; implGoal?: string; baseCommon?: boolean } = {}): unknown {
  const task = (id: string, module: string | null, writeScope: string[], dependsOn: string[], goal: string, implementsAdd = false) => ({
    id,
    kind: module === null ? 'integration' : 'implementation',
    module,
    goal,
    standards: [{ id: 'S1', text: 'its check passes' }],
    requirementItems: [`item.${M}.g1`],
    writeScope,
    readableFiles: ['README.md'],
    interpreter: 'node',
    verificationCommands: [{ id: 'check', command: 'node check.js' }],
    implements: implementsAdd ? ['add'] : [],
    calls: [],
    dependsOn,
    exclusive: [],
    estimate: { durationMs: 60_000, costMicros: 100_000, basis: 'small' },
    provenance: { planElement: 'e1' },
  });
  const modules = ['core', 'lib', ...(o.extra === 'ext' ? ['ext'] : [])];
  const extra = o.extra === undefined ? [] : [task('extra', o.extra === 'ext' ? 'ext' : 'lib', o.extra === 'ext' ? ['ext/**'] : ['lib/common.txt'], [], 'Task extra')];
  return {
    reusedInterfaces: [],
    newInterfaces: [{ name: 'add', definition: 'add(a: number, b: number): number', searched: 'searched the repository: no arithmetic helpers exist', provenance: { planElement: 'e1' } }],
    modules: modules.map((id) => ({ id, writeScope: [`${id}/**`], provenance: { planElement: 'e1' } })),
    tasks: [
      task('base', 'core', o.baseCommon ? ['core/**', 'lib/common.txt'] : ['core/**'], [], o.baseGoal ?? 'Task base', true),
      ...extra,
      task('impl', 'lib', ['lib/**'], o.extra === undefined ? ['base'] : ['base', 'extra'], o.implGoal ?? 'Task impl'),
      task('use', null, ['app/**'], ['impl'], 'Task use'),
    ],
    risks: [],
  };
}

const gitIn = (dir: string, ...args: string[]): string => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();

async function ready(pp: ProcessProject, kind: string, task: string) {
  const next = await pmNext(pp.ctx);
  const s = next.ready.find((r) => r.kind === kind && r.step.includes(`.${task}.`));
  if (s === undefined) {
    assert.fail(
      `no ready ${kind} of ${task}; ready: ${next.ready.map((r) => r.step).join(', ') || 'none'}; held: ${next.held.map((h) => `${h.step}: ${h.why}`).join('; ') || 'none'}; ` +
        `notices: ${next.notices.map((n) => `${n.category}: ${n.trigger}`).join(' | ') || 'none'}`,
    );
  }
  return s;
}

/** A Constructor attempt of `task`: dispatched, `files` changed in its worktree, handed back. */
async function construct(pp: ProcessProject, task: string, files: Readonly<Record<string, string | null>>): Promise<{ start: string; candidate: string }> {
  const s = await ready(pp, 'constructor', task);
  const d = pmDispatch(pp.ctx, s.step);
  const wt = join(pp.dir, d.worktree!);
  const start = gitIn(wt, 'rev-parse', 'HEAD');
  for (const [rel, text] of Object.entries(files)) {
    if (text === null) rmSync(join(wt, ...rel.split('/')));
    else write(wt, rel, text);
  }
  const a = await handBack(pp.ctx, d.dispatch, { done: 'done', unmet_standards: [], unfixed_problems: [], decisions_needed: [] });
  assert.ok(a.kind === 'recorded' && a.candidate !== null, JSON.stringify(a));
  return { start, candidate: a.candidate.commit };
}

/** The Reviewer of `task`: a pass, or a rework. */
async function reviewOf(pp: ProcessProject, task: string, verdict: 'pass' | 'rework'): Promise<ReviewerCard> {
  const s = await ready(pp, 'reviewer', task);
  const d = pmDispatch(pp.ctx, s.step, { filledBy: 'test-harness/scripted' });
  readAll(pp.ctx, d.dispatch);
  const c = dispatchView(pp.ctx, d.dispatch).card as unknown as ReviewerCard;
  const fields =
    verdict === 'pass'
      ? reviewerPass(c)
      : { ...(reviewerPass(c) as object), judgments: c.standards.map((x) => ({ standard: x.id, met: 'no', reason: 'not enough yet', evidence: c.verificationRuns.map((r) => `evidence:${r.evidence}`) })), verdict: 'rework' };
  const a = await handBack(pp.ctx, d.dispatch, fields);
  assert.notEqual(a.kind, 'refused', JSON.stringify(a));
  return c;
}

function record(pp: ProcessProject, id: string): ObjectVersionRecord {
  const c = pp.ctx.memory.read((db) => factById(db, 'object.version', id));
  assert.ok(c !== null, `${id} is recorded`);
  return c.record as ObjectVersionRecord;
}

function filesOf(pp: ProcessProject, commit: string): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const path of PATHS) {
    try {
      out[path] = execFileSync('git', ['cat-file', 'blob', `${commit}:${path}`], { cwd: pp.dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      out[path] = null;
    }
  }
  return out;
}

const files = (o: Readonly<Record<string, string | null>>): Record<string, string | null> => ({ 'core/x.txt': 'x0\n', 'ext/e.txt': null, 'lib/a.txt': 'a0\n', 'lib/b.txt': 'b0\n', 'lib/common.txt': 'common0\n', ...o });

async function decompose(pp: ProcessProject, detailed: unknown): Promise<void> {
  await step(pp.ctx, 'calibrator-1', (c) => cal1Pass(c));
  await step(pp.ctx, 'architect-decompose', () => detailed);
  if ((await pmNext(pp.ctx)).ready.some((r) => r.kind === 'architect-feasibility')) await step(pp.ctx, 'architect-feasibility', () => feasible());
  await step(pp.ctx, 'calibrator-2', (c) => cal2Pass(c));
}

/** The mission planned (round 1: base → impl → use), base accepted, impl's first attempt handed back. */
async function firstAttempt(baseCommon = false): Promise<{ pp: ProcessProject; words: string; first: { start: string; candidate: string } }> {
  const pp = processProject({ files: BASE_FILES });
  const words = await startAddMission(pp.ctx, M);
  await decompose(pp, plan({ baseCommon }));
  await construct(pp, 'base', { 'core/x.txt': 'x1\n' });
  await reviewOf(pp, 'base', 'pass');
  const first = await construct(pp, 'impl', { 'lib/a.txt': 'a1\n', 'lib/common.txt': 'common1\n' });
  return { pp, words, first };
}

/** A re-plan (round `round`) with the detailed plan `detailed`. */
async function replan(pp: ProcessProject, words: string, round: number, detailed: unknown): Promise<void> {
  const w = pmSay(pp.ctx, `Change the plan, round ${round}. (${M})`).words;
  await pmPlan(pp.ctx, { mission: M, plan: { ...(addPlan(M, words) as Record<string, unknown>), round }, words: [words, w] });
  await decompose(pp, detailed);
}

describe("a later attempt starts from its dependencies' current work", () => {
  it("a changed card adds a dependency: the new spec starts fresh; closure snapshots and delivery compose", async () => {
    const s = await firstAttempt();
    p = s.pp;
    await replan(p, s.words, 2, plan({ extra: 'ext' }));
    await construct(p, 'extra', { 'ext/e.txt': 'e1\n' });
    await reviewOf(p, 'extra', 'pass');
    const second = await construct(p, 'impl', { 'lib/b.txt': 'b2\n' });
    // A changed card starts a new spec on the dependencies without the old spec's work.
    assert.notEqual(second.start, s.first.candidate, 'not the previous candidate: a dependency was added since');
    assert.deepEqual(filesOf(p, second.start), files({ 'core/x.txt': 'x1\n', 'ext/e.txt': 'e1\n', 'lib/a.txt': 'a0\n', 'lib/common.txt': 'common0\n' }));
    const fresh = (await p.ctx.actions().snapshot({ mission: M, purpose: 'test', products: [prod('base', 1), prod('extra', 1)] })).commit;
    assert.equal(second.start, fresh, "a changed card starts without the old spec's work");
    const accepting = await reviewOf(p, 'impl', 'pass');
    await pmNext(p.ctx);
    const rec = record(p, prod('impl', 2));
    assert.equal(rec.predecessor, undefined);
    assert.equal(rec.source?.origin, fresh, "the new snapshot is the version's origin");
    assert.deepEqual(accepting.candidate.changedPaths, ['lib/b.txt'], 'the new spec changes only b');
    assert.equal(p.git('diff', '--name-only', fresh, second.candidate), 'lib/b.txt');
    // a delivery of the three composes without a conflict, all proven
    const words = pmSay(p.ctx, 'Deliver the library.').words;
    const del = await pmDeliver(p.ctx, { mission: M, delivery: 'v1', selected: [prod('base', 1), prod('extra', 1), prod('impl', 2)].map((id) => ({ kind: 'object' as const, id })), words });
    assert.equal(del.kind, 'delivered', JSON.stringify(del));
    if (del.kind !== 'delivered') return;
    assert.deepEqual(filesOf(p, del.record.commit), files({ 'core/x.txt': 'x1\n', 'ext/e.txt': 'e1\n', 'lib/a.txt': 'a0\n', 'lib/b.txt': 'b2\n', 'lib/common.txt': 'common0\n' }));
    assert.deepEqual(del.record.proof?.notFullyProven, []);
    assert.deepEqual([...(del.record.proof?.proven ?? [])].sort(), [prod('base', 1), prod('extra', 1), prod('impl', 2)]);
    // use depends on impl only; its snapshot also includes impl's complete prerequisite closure.
    const use = await ready(p, 'constructor', 'use');
    const d = pmDispatch(p.ctx, use.step);
    assert.equal(readFileSync(join(p.dir, d.worktree!, 'lib', 'a.txt'), 'utf8'), 'a0\n');
    assert.equal(readFileSync(join(p.dir, d.worktree!, 'lib', 'b.txt'), 'utf8'), 'b2\n');
    assert.equal(readFileSync(join(p.dir, d.worktree!, 'ext', 'e.txt'), 'utf8'), 'e1\n', 'the prerequisite closure includes extra');
  });

  it('a dependency accepted again at a newer version: the rework sees the newer version', async () => {
    const s = await firstAttempt();
    p = s.pp;
    // base's card changes: it is built again and accepted at its second attempt
    await replan(p, s.words, 2, plan({ baseGoal: 'Task base, again' }));
    await construct(p, 'base', { 'core/x.txt': 'x2\n' });
    await reviewOf(p, 'base', 'pass');
    await reviewOf(p, 'impl', 'rework');
    const second = await construct(p, 'impl', { 'lib/b.txt': 'b2\n' });
    assert.deepEqual(filesOf(p, second.start), files({ 'core/x.txt': 'x2\n', 'lib/a.txt': 'a1\n', 'lib/common.txt': 'common1\n' }));
    const fresh = (await p.ctx.actions().snapshot({ mission: M, purpose: 'test', products: [prod('base', 2)] })).commit;
    assert.equal(p.git('rev-parse', `${second.start}^`), fresh);
    await reviewOf(p, 'impl', 'pass');
    await pmNext(p.ctx);
    assert.equal(record(p, prod('impl', 2)).source?.origin, fresh);
  });

  it('hand-back pins the old dependency even when a new version is accepted while the attempt runs', async () => {
    p = processProject({ files: BASE_FILES });
    const words = await startAddMission(p.ctx, M);
    await decompose(p, plan());
    await construct(p, 'base', { 'core/x.txt': 'x1\n' });
    await reviewOf(p, 'base', 'pass');
    const con = await ready(p, 'constructor', 'impl');
    const d = pmDispatch(p.ctx, con.step);
    const wt = join(p.dir, d.worktree!);
    assert.equal(readFileSync(join(wt, 'core/x.txt'), 'utf8'), 'x1\n');
    await replan(p, words, 2, plan({ baseGoal: 'Base version two' }));
    await construct(p, 'base', { 'core/x.txt': 'x2\n' });
    await reviewOf(p, 'base', 'pass');
    write(wt, 'lib/a.txt', 'a1\n');
    const back = await handBack(p.ctx, d.dispatch, { done: 'done', unmet_standards: [], unfixed_problems: [], decisions_needed: [] });
    assert.ok(back.kind === 'recorded' && back.candidate !== null);
    await reviewOf(p, 'impl', 'pass');
    const product = record(p, prod('impl', 1));
    assert.deepEqual(p.ctx.memory.data.getList(product.prerequisites), [prod('base', 1)]);
    const delivered = await pmDeliver(p.ctx, { mission: M, delivery: 'mismatched', selected: [prod('base', 2), prod('impl', 1)].map((id) => ({ kind: 'object' as const, id })), words });
    assert.equal(delivered.kind, 'incompatible', 'A2 cannot substitute for the A1 this attempt was built on');
  });

  it('no dependency changed: the rework continues from the previous candidate, as before', async () => {
    const s = await firstAttempt();
    p = s.pp;
    await reviewOf(p, 'impl', 'rework');
    const second = await construct(p, 'impl', { 'lib/b.txt': 'b2\n' });
    assert.equal(second.start, s.first.candidate);
    await reviewOf(p, 'impl', 'pass');
    await pmNext(p.ctx);
    assert.equal(record(p, prod('impl', 2)).source?.origin, s.first.start, "the first attempt's snapshot stays the origin");
  });

  it('a carried change that conflicts with a new dependency builds nothing: the attempt waits with a notice; a re-plan of its card starts it afresh', async () => {
    const s = await firstAttempt(true);
    p = s.pp;
    await replan(p, s.words, 2, plan({ baseCommon: true, baseGoal: 'Base with revised common' }));
    await construct(p, 'base', { 'core/x.txt': 'x2\n', 'lib/common.txt': 'common-extra\n' });
    await reviewOf(p, 'base', 'pass');
    await reviewOf(p, 'impl', 'rework');
    const next = await pmNext(p.ctx);
    assert.ok(!next.ready.some((r) => r.kind === 'constructor' && r.step.includes('.impl.')), 'no attempt of impl is ready');
    const n = next.notices.find((x) => x.category === 'rework-start-conflict');
    assert.ok(n !== undefined, `a notice: ${next.notices.map((x) => `${x.category}: ${x.trigger}`).join(' | ')}`);
    assert.match(n.trigger, /lib\/common\.txt/);
    // the way out: a re-plan that changes impl's card starts its next attempt from its dependencies' current work
    await replan(p, s.words, 3, plan({ baseCommon: true, baseGoal: 'Base with revised common', implGoal: 'Task impl, on the shared file' }));
    const third = await construct(p, 'impl', { 'lib/common.txt': 'common-extra and impl\n' });
    assert.equal(third.start, (await p.ctx.actions().snapshot({ mission: M, purpose: 'test', products: [prod('base', 2)] })).commit);
    assert.deepEqual(filesOf(p, third.start), files({ 'core/x.txt': 'x2\n', 'lib/common.txt': 'common-extra\n' }));
  });
});
