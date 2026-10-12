// The change a product version brings after a rework (design 4.1 §6.2, §6.7, Appendix H).
//
// A rework's Constructor continues in a worktree at the previous attempt's candidate, so the
// candidate of a later attempt has the previous attempt's commit as its parent. A product
// version's own change is everything since the snapshot its first attempt started from (its
// origin), not only the last attempt's: a dependent task's snapshot and a delivery candidate lay
// all of it over their base, three-way, and report a conflict only where the base itself changed
// a path differently. A version recorded without an origin (by an engine that did not record it)
// finds it by walking its predecessors.
//
// The scenario: three tasks, base → impl → use (each its own write scope; use integrates the two
// modules). impl is sent back twice and accepted at its third attempt; each attempt changes files
// of its own and one common file, the first adds a file and the second deletes one.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import type { MissionId, ObjectVersionId } from '../src/common/ids.ts';
import type { ObjectVersionRecord } from '../src/common/records.ts';
import { cal1Pass, cal2Pass, feasible } from '../src/flow/scripted.ts';
import { appendRecords, factById } from '../src/memory/index.ts';
import { pmDeliver, pmDispatch, pmNext, pmPlan, pmSay } from '../src/process/index.ts';
import type { ReviewerCard } from '../src/seat/card.ts';
import { addPlan, handBack, processProject, reviewerPass, startAddMission, step, write, type ProcessProject } from './process-fixtures.ts';

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
  'lib/c.txt': 'c0\n',
  'lib/common.txt': 'common0\n',
  'lib/old.txt': 'old0\n',
  'lib/untouched.txt': 'untouched0\n',
  'app/main.txt': 'main0\n',
};

/** What each attempt of impl changes in its worktree (null: deleted). */
const ATTEMPTS: ReadonlyArray<Readonly<Record<string, string | null>>> = [
  { 'lib/a.txt': 'a1\n', 'lib/new1.txt': 'new1\n', 'lib/common.txt': 'common1\n' },
  { 'lib/b.txt': 'b2\n', 'lib/old.txt': null, 'lib/common.txt': 'common2\n' },
  { 'lib/c.txt': 'c3\n', 'lib/common.txt': 'common3\n' },
];
/** The version accepted at the third attempt: its change since the snapshot its first attempt started from. */
const CUMULATIVE: Readonly<Record<string, string | null>> = { 'lib/a.txt': 'a1\n', 'lib/b.txt': 'b2\n', 'lib/c.txt': 'c3\n', 'lib/common.txt': 'common3\n', 'lib/new1.txt': 'new1\n', 'lib/old.txt': null };
const CHANGED = Object.keys(CUMULATIVE).sort();

function plan(o: { implGoal?: string } = {}): unknown {
  const task = (id: string, dir: string, dependsOn: string[], goal: string, implementsAdd = false) => ({
    id,
    // two module tasks need one integration task after them (3.5)
    kind: dir === 'app' ? 'integration' : 'implementation',
    module: dir === 'app' ? null : dir,
    goal,
    standards: [{ id: 'S1', text: 'its check passes' }],
    requirementItems: [`item.${M}.g1`],
    writeScope: [`${dir}/**`],
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
  return {
    reusedInterfaces: [],
    newInterfaces: [{ name: 'add', definition: 'add(a: number, b: number): number', searched: 'searched the repository: no arithmetic helpers exist', provenance: { planElement: 'e1' } }],
    modules: ['core', 'lib'].map((id) => ({ id, writeScope: [`${id}/**`], provenance: { planElement: 'e1' } })),
    tasks: [task('base', 'core', [], 'Task base', true), task('impl', 'lib', ['base'], o.implGoal ?? 'Task impl'), task('use', 'app', ['impl'], 'Task use')],
    risks: [],
  };
}

function gitIn(dir: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
}

/** The one ready step of `kind` for plan task `task`, or a failure naming what is ready, held and noticed. */
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
async function construct(pp: ProcessProject, task: string, files: Readonly<Record<string, string | null>>): Promise<{ start: string; candidate: string; worktree: string }> {
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
  return { start, candidate: a.candidate.commit, worktree: wt };
}

/** The one ready Reviewer: a pass, or a rework that says `why` (a different reason each time: no "no progress"). */
async function review(pp: ProcessProject, verdict: 'pass' | 'rework', why = ''): Promise<ReviewerCard> {
  let seen: ReviewerCard | null = null;
  await step(pp.ctx, 'reviewer', (c: ReviewerCard) => {
    seen = c;
    if (verdict === 'pass') return reviewerPass(c);
    return {
      ...(reviewerPass(c) as object),
      judgments: c.standards.map((x) => ({ standard: x.id, met: 'no', reason: why, evidence: c.verificationRuns.map((r) => `evidence:${r.evidence}`) })),
      verdict: 'rework',
    };
  });
  return seen as unknown as ReviewerCard;
}

function record(pp: ProcessProject, id: string): ObjectVersionRecord {
  const c = pp.ctx.memory.read((db) => factById(db, 'object.version', id));
  assert.ok(c !== null, `${id} is recorded`);
  return c.record as ObjectVersionRecord;
}

/** Files of a commit (null: absent). */
function filesOf(pp: ProcessProject, commit: string, paths: readonly string[]): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const path of paths) {
    try {
      out[path] = execFileSync('git', ['cat-file', 'blob', `${commit}:${path}`], { cwd: pp.dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      out[path] = null;
    }
  }
  return out;
}

/** Files of a directory (null: absent). */
function filesIn(dir: string, paths: readonly string[]): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const path of paths) {
    const abs = join(dir, ...path.split('/'));
    out[path] = existsSync(abs) ? readFileSync(abs, 'utf8') : null;
  }
  return out;
}

const blobOf = (pp: ProcessProject, text: string): string => execFileSync('git', ['hash-object', '--stdin'], { cwd: pp.dir, input: text, encoding: 'utf8' }).trim();

/** A commit on `parent` with `files` changed (null: deleted), written with a temporary index; no ref names it. */
function commitOn(pp: ProcessProject, parent: string, files: Readonly<Record<string, string | null>>, message: string): string {
  const env = { ...process.env, GIT_INDEX_FILE: join(dirname(pp.dir), 'scratch-index'), GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
  const run = (args: string[], input?: string) => execFileSync('git', args, { cwd: pp.dir, env, encoding: 'utf8', ...(input !== undefined ? { input } : {}) }).trim();
  run(['read-tree', parent]);
  for (const [path, text] of Object.entries(files)) {
    if (text === null) run(['update-index', '--force-remove', '--', path]);
    else run(['update-index', '--add', '--cacheinfo', `100644,${run(['hash-object', '-w', '--stdin'], text)},${path}`]);
  }
  return run(['commit-tree', run(['write-tree']), '-p', parent, '-m', message]);
}

/** The target branch moves: a commit on main with `files` changed. */
function commitOnMain(pp: ProcessProject, files: Readonly<Record<string, string | null>>): string {
  for (const [rel, text] of Object.entries(files)) {
    if (text === null) rmSync(join(pp.dir, ...rel.split('/')));
    else write(pp.dir, rel, text);
  }
  pp.git('add', '-A');
  pp.git('commit', '-q', '-m', 'meanwhile on main');
  return pp.git('rev-parse', 'HEAD');
}

const ALL_PATHS = [...new Set([...Object.keys(BASE_FILES), ...CHANGED])].sort();

/** The files of a snapshot or a delivery of impl's accepted version on an unchanged base (`core`: base's product, which a delivery brings as a prerequisite). */
function expectedFiles(o: { core?: string } = {}): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const path of ALL_PATHS) out[path] = path in CUMULATIVE ? CUMULATIVE[path]! : (BASE_FILES[path] ?? null);
  if (o.core !== undefined) out['core/x.txt'] = o.core;
  return out;
}

interface Reworked {
  readonly pp: ProcessProject;
  /** The snapshot impl's first attempt started from (the mission base with base's product laid over it). */
  readonly origin: string;
  /** impl's three candidates. */
  readonly candidates: readonly string[];
  /** The card of the Reviewer that accepted the third attempt. */
  readonly accepting: ReviewerCard;
}

/** The decision layer's steps for a detailed plan: the Architect, its feasibility review, Calibrator ②. */
async function decompose(pp: ProcessProject, detailed: unknown): Promise<void> {
  await step(pp.ctx, 'calibrator-1', (c) => cal1Pass(c));
  await step(pp.ctx, 'architect-decompose', () => detailed);
  if ((await pmNext(pp.ctx)).ready.some((r) => r.kind === 'architect-feasibility')) await step(pp.ctx, 'architect-feasibility', () => feasible());
  await step(pp.ctx, 'calibrator-2', (c) => cal2Pass(c));
}

/** The mission planned; returns the words of its PM plan. */
async function planned(): Promise<{ pp: ProcessProject; words: string }> {
  const pp = processProject({ files: BASE_FILES });
  const words = await startAddMission(pp.ctx, M);
  await decompose(pp, plan());
  return { pp, words };
}

/** base accepted; impl sent back twice and accepted at its third attempt. */
async function reworkedTwice(): Promise<Reworked> {
  const { pp } = await planned();
  await construct(pp, 'base', { 'core/x.txt': 'x1\n' });
  await review(pp, 'pass');
  const candidates: string[] = [];
  let origin = '';
  let accepting: ReviewerCard | null = null;
  for (let k = 1; k <= 3; k++) {
    const c = await construct(pp, 'impl', ATTEMPTS[k - 1]!);
    if (k === 1) origin = c.start;
    else assert.equal(c.start, candidates[k - 2], `attempt ${k} continues in a worktree at attempt ${k - 1}'s candidate`);
    // the premise: a candidate's only parent is the commit its worktree started from
    assert.equal(pp.git('rev-parse', `${c.candidate}^`), c.start);
    candidates.push(c.candidate);
    accepting = await review(pp, k < 3 ? 'rework' : 'pass', `the check of attempt ${k} is not enough yet`);
  }
  await pmNext(pp.ctx);
  assert.equal(pp.git('rev-parse', `${origin}^`), pp.git('rev-parse', 'main'), "impl's first snapshot is the mission base with base's product laid over it");
  return { pp, origin, candidates, accepting: accepting! };
}

describe('a product version accepted after a rework brings every attempt’s change', () => {
  it("records the first attempt's snapshot as its origin; the dependent task's snapshot holds every attempt's change", async () => {
    const w = await reworkedTwice();
    p = w.pp;
    // the dependent task gets its card: its worktree is the mission base with impl's whole change laid over it
    const s = await ready(p, 'constructor', 'use');
    const d = pmDispatch(p.ctx, s.step);
    const wt = join(p.dir, d.worktree!);
    const snapshot = gitIn(wt, 'rev-parse', 'HEAD');
    assert.equal(p.git('rev-parse', `${snapshot}^`), p.git('rev-parse', 'main'), 'laid over the mission base');
    assert.deepEqual(filesOf(p, snapshot, ALL_PATHS), expectedFiles());
    assert.deepEqual(filesIn(wt, ALL_PATHS), expectedFiles());
    assert.equal(p.git('diff', '--name-only', 'main', snapshot), CHANGED.join('\n'), 'nothing else changed');

    // the version records where its change starts: the snapshot its first attempt started from
    const rec = record(p, prod('impl', 3));
    assert.equal(rec.predecessor, prod('impl', 2));
    assert.equal(rec.source?.commit, w.candidates[2]);
    assert.equal(rec.source?.origin, w.origin, 'the origin is the snapshot the first attempt started from, not the parent');
    assert.equal(record(p, prod('impl', 1)).source?.origin, w.origin, 'a first attempt: its origin is its parent');
    assert.equal(record(p, prod('impl', 2)).source?.origin, w.origin);
    // the Reviewer that accepted it was shown every path the version changes, not only the last attempt's
    assert.deepEqual(w.accepting.candidate.changedPaths, CHANGED);
  });

  it("a delivery of the version holds every attempt's change, with no conflict, proven", async () => {
    const w = await reworkedTwice();
    p = w.pp;
    const words = pmSay(p.ctx, 'Deliver the library.').words;
    const del = await pmDeliver(p.ctx, { mission: M, delivery: 'v1', selected: [{ kind: 'object', id: prod('impl', 3) }], words });
    assert.equal(del.kind, 'delivered', JSON.stringify(del));
    if (del.kind !== 'delivered') return;
    // base's product comes in as impl's prerequisite
    assert.deepEqual(filesOf(p, del.record.commit, ALL_PATHS), expectedFiles({ core: 'x1\n' }));
    assert.equal(p.git('rev-parse', `${del.record.commit}^`), p.git('rev-parse', 'main'));
    assert.deepEqual(del.record.proof?.notFullyProven, [], 'the candidate holds exactly the accepted versions');
    assert.deepEqual([...(del.record.proof?.proven ?? [])].sort(), [prod('base', 1), prod('impl', 3)]);
  });

  it('a path the base changed differently since the line began is still a conflict, an earlier attempt’s path included; nothing else is', async () => {
    const w = await reworkedTwice();
    p = w.pp;
    // main moves on: common.txt (changed by every attempt) and b.txt (changed by the second attempt only) differently;
    // a.txt as the first attempt did; untouched.txt, which the version leaves alone
    commitOnMain(p, { 'lib/common.txt': 'common on main\n', 'lib/b.txt': 'b on main\n', 'lib/a.txt': 'a1\n', 'lib/untouched.txt': 'untouched on main\n' });
    const expected = [
      { path: 'lib/b.txt', original: blobOf(p, 'b0\n'), delivered: blobOf(p, 'b2\n'), base: blobOf(p, 'b on main\n') },
      { path: 'lib/common.txt', original: blobOf(p, 'common0\n'), delivered: blobOf(p, 'common3\n'), base: blobOf(p, 'common on main\n') },
    ];
    const shape = (cs: ReadonlyArray<{ path: string; original: { oid: string } | null; delivered: { oid: string } | null; base: { oid: string } | null }>) =>
      cs.map((c) => ({ path: c.path, original: c.original?.oid ?? null, delivered: c.delivered?.oid ?? null, base: c.base?.oid ?? null }));
    // a dependent's snapshot on the moved base
    await assert.rejects(p.ctx.actions().snapshot({ mission: M, purpose: 'test', products: [prod('impl', 3)] }), (e: { code?: string; detail?: unknown }) => {
      assert.equal(e.code, 'conflict');
      assert.deepEqual(shape(e.detail as never), expected);
      return true;
    });
    // a delivery on the moved base
    const words = pmSay(p.ctx, 'Deliver the library.').words;
    const del = await pmDeliver(p.ctx, { mission: M, delivery: 'v1', selected: [{ kind: 'object', id: prod('impl', 3) }], words });
    assert.equal(del.kind, 'conflict', JSON.stringify(del));
    if (del.kind !== 'conflict') return;
    assert.deepEqual(shape(del.conflicts), expected);
    assert.ok(del.conflicts.every((c) => c.version === prod('impl', 3)));
  });

  it('versions recorded without an origin find it by walking their predecessors; a rework recorded on top of them records it', async () => {
    const w = await reworkedTwice();
    p = w.pp;
    const ctx = p.ctx;
    // the three versions again, as an engine that did not record the origin wrote them (same commits, same chain)
    const legacy = (k: number) => `legacy.impl.${k}`;
    const recs = [1, 2, 3].map((k): ObjectVersionRecord => {
      const { predecessor: _p, source, ...rest } = record(p!, prod('impl', k));
      const { origin: _o, ...oldSource } = source!;
      return { ...rest, object: legacy(k) as ObjectVersionId, source: oldSource, ...(k > 1 ? { predecessor: legacy(k - 1) as ObjectVersionId } : {}) };
    });
    assert.ok(recs.every((r) => !('origin' in (r.source as object))));
    ctx.memory.write({ op: 'test:versions-without-origin', payload: {} }, (tx) => appendRecords(tx, recs));

    // a dependent's snapshot (the program's snapshot action) of the third
    const snap = await ctx.actions().snapshot({ mission: M, purpose: 'test', products: [legacy(3)] });
    assert.deepEqual(filesOf(p, snap.commit, ALL_PATHS), expectedFiles());
    // a delivery candidate of the third (the delivery's proof view): no conflict, every attempt's change
    const words = pmSay(ctx, 'Deliver the library.').words;
    const del = await pmDeliver(ctx, { mission: M, delivery: 'v1', selected: [{ kind: 'object', id: legacy(3) as ObjectVersionId }], words });
    assert.equal(del.kind, 'delivered', JSON.stringify(del));
    if (del.kind === 'delivered') assert.deepEqual(filesOf(p, del.record.commit, ALL_PATHS), expectedFiles({ core: 'x1\n' }));

    // the next attempt, recorded now on top of the chain: the first attempt's snapshot is its origin
    const c4 = commitOn(p, w.candidates[2]!, { 'lib/d.txt': 'd4\n' }, 'attempt 4');
    const pv = await ctx.actions().product({
      mission: M,
      module: 'lib',
      task: 'con.legacy.impl.4',
      dispatch: 'con.legacy.impl.4',
      candidate: c4,
      base: w.candidates[2]!,
      writeScope: ['lib/**'],
      taskType: 'implementation',
      prerequisites: [],
      reviews: recs[2]!.reviews,
      predecessor: legacy(3),
    });
    assert.equal(record(p, pv.object).source?.origin, w.origin);
    assert.deepEqual(pv.changedPaths, [...CHANGED, 'lib/d.txt'].sort(), 'its changed paths are its whole change');
  });

  it('a version whose commit was not built on its predecessor’s takes its parent as the origin', async () => {
    const w = await reworkedTwice();
    p = w.pp;
    const ctx = p.ctx;
    // recorded with the third version as its predecessor, but built on the mission base: nothing of the chain is its change
    const main = p.git('rev-parse', 'main');
    const fresh = commitOn(p, main, { 'lib/a.txt': 'a fresh\n' }, 'a fresh start');
    const pv = await ctx.actions().product({
      mission: M,
      module: 'lib',
      task: 'con.fresh.impl.1',
      dispatch: 'con.fresh.impl.1',
      candidate: fresh,
      base: main,
      writeScope: ['lib/**'],
      taskType: 'implementation',
      prerequisites: [],
      reviews: record(p, prod('impl', 3)).reviews,
      predecessor: prod('impl', 3),
    });
    assert.equal(record(p, pv.object).source?.origin, main);
    assert.deepEqual(pv.changedPaths, ['lib/a.txt']);
    const snap = await ctx.actions().snapshot({ mission: M, purpose: 'test', products: [pv.object] });
    assert.equal(p.git('diff', '--name-only', main, snap.commit), 'lib/a.txt');
  });

  it("a re-plan that changes the card continues from the previous attempt's candidate: the version accepted under the new card still brings every attempt's change", async () => {
    const start = await planned();
    p = start.pp;
    const ctx = p.ctx;
    await construct(p, 'base', { 'core/x.txt': 'x1\n' });
    await review(p, 'pass');
    const first = await construct(p, 'impl', ATTEMPTS[0]!);
    await review(p, 'rework', 'not enough yet');
    const second = await construct(p, 'impl', ATTEMPTS[1]!);
    assert.equal(second.start, first.candidate);
    // the plan changes impl's card while its second attempt waits for review: it restarts at the next attempt
    const w = pmSay(ctx, `Give the library task a sharper goal. (${M})`).words;
    await pmPlan(ctx, { mission: M, plan: { ...(addPlan(M, start.words) as Record<string, unknown>), round: 2 }, words: [start.words, w] });
    await decompose(p, plan({ implGoal: 'Task impl, with a sharper goal' }));
    const third = await construct(p, 'impl', ATTEMPTS[2]!);
    assert.equal(third.start, second.candidate, "the new card's attempt continues from the previous attempt's candidate");
    await review(p, 'pass');
    await pmNext(ctx);
    const s = await ready(p, 'constructor', 'use');
    const d = pmDispatch(ctx, s.step);
    assert.deepEqual(filesIn(join(p.dir, d.worktree!), ALL_PATHS), expectedFiles());
    const rec = record(p, prod('impl', 3));
    assert.equal(rec.predecessor, prod('impl', 2));
    assert.equal(rec.source?.origin, first.start);
  });
});
