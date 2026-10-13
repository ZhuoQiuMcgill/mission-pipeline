// Product versions stacked on each other (design 4.1 Appendix L).
//
// A dependent task's work starts from a snapshot that already holds its dependencies' products, so
// its version's change is taken against that snapshot (its origin, Appendix H). When a dependent and
// the version it rests on change the same file, the dependent's "started from" side is the other's
// entry, not the base's. A snapshot of both (a later task depending on both, an Auditor's), and a
// delivery of the chain, lay them over the base one after the other, each after the versions it
// rests on, and compare each with the base as the versions before it left it: no conflict, whatever
// the order of their ids. A path the base or an unrelated version changed differently from what a
// version started from is still a conflict.
//
// The scenario: three tasks, zeta → alpha → use (alpha depends on zeta; use, the integration task,
// on both). zeta and alpha share a module and its write scope; alpha changes, on top of zeta's
// version, a file zeta changed, and adds one. The names put the dependent first by id.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import type { MissionId, ObjectVersionId } from '../src/common/ids.ts';
import type { ObjectVersionRecord } from '../src/common/records.ts';
import { buildManifest } from '../src/delivery/manifest.ts';
import { cal1Pass, cal2Pass, feasible } from '../src/flow/scripted.ts';
import { factById } from '../src/memory/index.ts';
import { pmDeliver, pmDispatch, pmNext, pmSay } from '../src/process/index.ts';
import { FakeProofView, fakeObject, obj } from './delivery-fixtures.test.ts';
import { handBack, processProject, reviewerPass, startAddMission, step, write, type ProcessProject } from './process-fixtures.ts';

const M = 'm1' as MissionId;
const prod = (task: string, k = 1): ObjectVersionId => `prod.con.${M}.${task}.${k}` as ObjectVersionId;

let p: ProcessProject | null = null;
afterEach(() => {
  const q = p;
  p = null;
  q?.cleanup();
});

const BASE_FILES: Record<string, string> = {
  'check.js': "console.log('TAP version 13');\nconsole.log('ok 1 - fine');\n",
  'core/k.txt': 'k0\n',
  'lib/f.txt': 'f0\n',
  'lib/x.txt': 'x0\n',
  'app/main.txt': 'main0\n',
};
/** zeta's change, then alpha's on top of it (alpha changes zeta's f again and adds g). */
const ZETA: Readonly<Record<string, string>> = { 'lib/f.txt': 'f1\n', 'lib/x.txt': 'x1\n' };
const ALPHA: Readonly<Record<string, string>> = { 'lib/f.txt': 'f2\n', 'lib/g.txt': 'g2\n' };
const USE: Readonly<Record<string, string>> = { 'app/main.txt': 'main3\n' };
const PATHS = ['app/main.txt', 'core/k.txt', 'lib/f.txt', 'lib/g.txt', 'lib/x.txt', 'other/h.txt'];

function plan(): unknown {
  const task = (id: string, kind: string, module: string | null, writeScope: string[], dependsOn: string[], implementsAdd = false) => ({
    id,
    kind,
    module,
    goal: `Task ${id}`,
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
  return {
    reusedInterfaces: [],
    newInterfaces: [{ name: 'add', definition: 'add(a: number, b: number): number', searched: 'searched the repository: no arithmetic helpers exist', provenance: { planElement: 'e1' } }],
    modules: [{ id: 'lib', writeScope: ['lib/**'], provenance: { planElement: 'e1' } }],
    tasks: [
      // the dependent may write what the task it depends on writes (they never run in parallel)
      task('zeta', 'implementation', 'lib', ['lib/**'], [], true),
      task('alpha', 'implementation', 'lib', ['lib/**'], ['zeta']),
      task('use', 'integration', null, ['app/**'], ['zeta', 'alpha']),
    ],
    risks: [],
  };
}

function gitIn(dir: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
}

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

/** A Constructor attempt of `task`: dispatched, `files` changed in its worktree, handed back; the worktree's files as it started. */
async function construct(pp: ProcessProject, task: string, files: Readonly<Record<string, string>>): Promise<{ start: string; seen: Record<string, string | null> }> {
  const s = await ready(pp, 'constructor', task);
  const d = pmDispatch(pp.ctx, s.step);
  const wt = join(pp.dir, d.worktree!);
  const start = gitIn(wt, 'rev-parse', 'HEAD');
  const seen = filesIn(wt, PATHS);
  for (const [rel, text] of Object.entries(files)) write(wt, rel, text);
  const a = await handBack(pp.ctx, d.dispatch, { done: 'done', unmet_standards: [], unfixed_problems: [], decisions_needed: [] });
  assert.ok(a.kind === 'recorded' && a.candidate !== null, JSON.stringify(a));
  await step(pp.ctx, 'reviewer', (c) => reviewerPass(c));
  return { start, seen };
}

function filesIn(dir: string, paths: readonly string[]): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const path of paths) {
    const abs = join(dir, ...path.split('/'));
    out[path] = existsSync(abs) ? readFileSync(abs, 'utf8') : null;
  }
  return out;
}

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

const blobOf = (pp: ProcessProject, text: string): string => execFileSync('git', ['hash-object', '--stdin'], { cwd: pp.dir, input: text, encoding: 'utf8' }).trim();

/** A commit on `parent` with `files` changed, written with a temporary index; no ref names it. */
function commitOn(pp: ProcessProject, parent: string, files: Readonly<Record<string, string>>, message: string): string {
  const env = { ...process.env, GIT_INDEX_FILE: join(dirname(pp.dir), 'scratch-index'), GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
  const run = (args: string[], input?: string) => execFileSync('git', args, { cwd: pp.dir, env, encoding: 'utf8', ...(input !== undefined ? { input } : {}) }).trim();
  run(['read-tree', parent]);
  for (const [path, text] of Object.entries(files)) run(['update-index', '--add', '--cacheinfo', `100644,${run(['hash-object', '-w', '--stdin'], text)},${path}`]);
  return run(['commit-tree', run(['write-tree']), '-p', parent, '-m', message]);
}

function record(pp: ProcessProject, id: string): ObjectVersionRecord {
  const c = pp.ctx.memory.read((db) => factById(db, 'object.version', id));
  assert.ok(c !== null, `${id} is recorded`);
  return c.record as ObjectVersionRecord;
}

/** The files with `layers` laid over the base, in order. */
function expected(...layers: Readonly<Record<string, string>>[]): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const path of PATHS) out[path] = BASE_FILES[path] ?? null;
  for (const l of layers) Object.assign(out, l);
  return out;
}

/** The mission planned, zeta accepted, then alpha (built on zeta's version) accepted. */
async function stackedPair(): Promise<ProcessProject> {
  const pp = processProject({ files: BASE_FILES });
  await startAddMission(pp.ctx, M);
  await step(pp.ctx, 'calibrator-1', (c) => cal1Pass(c));
  await step(pp.ctx, 'architect-decompose', () => plan());
  if ((await pmNext(pp.ctx)).ready.some((r) => r.kind === 'architect-feasibility')) await step(pp.ctx, 'architect-feasibility', () => feasible());
  await step(pp.ctx, 'calibrator-2', (c) => cal2Pass(c));
  await construct(pp, 'zeta', ZETA);
  const a = await construct(pp, 'alpha', ALPHA);
  // the premise: alpha's work started from the base with zeta's version laid over it
  assert.deepEqual(a.seen, expected(ZETA));
  assert.equal(record(pp, prod('alpha')).source?.origin, a.start);
  assert.deepEqual(pp.ctx.memory.data.getList(record(pp, prod('alpha')).prerequisites), [prod('zeta')]);
  assert.ok(prod('alpha') < prod('zeta'), 'the dependent comes first by id');
  await pmNext(pp.ctx);
  return pp;
}

type Shape = { path: string; version: string; original: string | null; delivered: string | null; base: string | null; by: string | null };
const shape = (cs: ReadonlyArray<{ path: string; version: string; original: { oid: string } | null; delivered: { oid: string } | null; base: { oid: string } | null; by?: string | null }>): Shape[] =>
  cs.map((c) => ({ path: c.path, version: c.version, original: c.original?.oid ?? null, delivered: c.delivered?.oid ?? null, base: c.base?.oid ?? null, by: c.by ?? null }));

describe('product versions stacked on each other compose', () => {
  it("a task depending on both gets the base with zeta's and then alpha's change, whatever the order of their ids", async () => {
    p = await stackedPair();
    const main = p.git('rev-parse', 'main');
    const u = await construct(p, 'use', USE);
    assert.deepEqual(u.seen, expected(ZETA, ALPHA));
    assert.equal(p.git('rev-parse', `${u.start}^`), main, 'laid over the mission base');
    assert.equal(p.git('diff', '--name-only', main, u.start), ['lib/f.txt', 'lib/g.txt', 'lib/x.txt'].join('\n'), 'nothing else changed');
    // the program's snapshot action, the products in either order (an Auditor's snapshot of the chain takes the same path)
    for (const products of [[prod('alpha'), prod('zeta')], [prod('zeta'), prod('alpha')]]) {
      const snap = await p.ctx.actions().snapshot({ mission: M, purpose: 'test', products });
      assert.deepEqual(filesOf(p, snap.commit, PATHS), expected(ZETA, ALPHA));
    }
  });

  it('a delivery of the chain has no conflict and every version is proven', async () => {
    p = await stackedPair();
    await construct(p, 'use', USE);
    await pmNext(p.ctx);
    const words = pmSay(p.ctx, 'Deliver the work.').words;
    // alpha alone brings zeta as its prerequisite; use brings both
    const one = await pmDeliver(p.ctx, { mission: M, delivery: 'v1', selected: [{ kind: 'object', id: prod('alpha') }], words });
    assert.equal(one.kind, 'delivered', JSON.stringify(one));
    if (one.kind !== 'delivered') return;
    assert.deepEqual(filesOf(p, one.record.commit, PATHS), expected(ZETA, ALPHA));
    assert.deepEqual(one.record.proof?.notFullyProven, [], 'each version is read as it stands under the versions resting on it');
    assert.deepEqual([...(one.record.proof?.proven ?? [])].sort(), [prod('alpha'), prod('zeta')]);
    const all = await pmDeliver(p.ctx, { mission: M, delivery: 'v2', selected: [{ kind: 'object', id: prod('use') }], words });
    assert.equal(all.kind, 'delivered', JSON.stringify(all));
    if (all.kind !== 'delivered') return;
    assert.deepEqual(filesOf(p, all.record.commit, PATHS), expected(ZETA, ALPHA, USE));
    assert.equal(p.git('rev-parse', `${all.record.commit}^`), p.git('rev-parse', 'main'));
    assert.deepEqual(all.record.proof?.notFullyProven, []);
    assert.deepEqual([...(all.record.proof?.proven ?? [])].sort(), [prod('alpha'), prod('use'), prod('zeta')]);
  });

  it('the target branch changed the shared file after the work began: still a conflict, snapshot and delivery', async () => {
    p = await stackedPair();
    write(p.dir, 'lib/f.txt', 'f on main\n');
    p.git('add', '-A');
    p.git('commit', '-q', '-m', 'meanwhile on main');
    const onMain = blobOf(p, 'f on main\n');
    const want: Shape[] = [
      // zeta first: what it started from is no longer there; alpha then finds main's entry, not zeta's
      { path: 'lib/f.txt', version: prod('zeta'), original: blobOf(p, 'f0\n'), delivered: blobOf(p, 'f1\n'), base: onMain, by: null },
      { path: 'lib/f.txt', version: prod('alpha'), original: blobOf(p, 'f1\n'), delivered: blobOf(p, 'f2\n'), base: onMain, by: null },
    ];
    await assert.rejects(p.ctx.actions().snapshot({ mission: M, purpose: 'test', products: [prod('alpha'), prod('zeta')] }), (e: { code?: string; detail?: unknown }) => {
      assert.equal(e.code, 'conflict');
      assert.deepEqual(shape(e.detail as never), want);
      return true;
    });
    const words = pmSay(p.ctx, 'Deliver the work.').words;
    const del = await pmDeliver(p.ctx, { mission: M, delivery: 'v1', selected: [{ kind: 'object', id: prod('alpha') }], words });
    assert.equal(del.kind, 'conflict', JSON.stringify(del));
    if (del.kind === 'conflict') assert.deepEqual(shape(del.conflicts), want);
  });

  it('an unrelated version changed the shared file differently: a conflict naming it; unrelated versions on other files compose', async () => {
    p = await stackedPair();
    const ctx = p.ctx;
    const main = p.git('rev-parse', 'main');
    const reviews = record(p, prod('zeta')).reviews;
    const unrelated = async (task: string, module: string, files: Readonly<Record<string, string>>, writeScope: string[]) =>
      (
        await ctx.actions().product({
          mission: M,
          module,
          task,
          dispatch: task,
          candidate: commitOn(p!, main, files, task),
          base: main,
          writeScope,
          taskType: 'implementation',
          prerequisites: [],
          reviews,
          predecessor: null,
        })
      ).object;
    // built on the mission base, with no prerequisite: it never saw zeta's version (its id sorts before zeta's)
    const other = await unrelated('con.a.other.1', 'lib', { 'lib/f.txt': 'f other\n' }, ['lib/**']);
    assert.ok(other < prod('zeta'));
    await assert.rejects(ctx.actions().snapshot({ mission: M, purpose: 'test', products: [prod('zeta'), other] }), (e: { code?: string; detail?: unknown }) => {
      assert.equal(e.code, 'conflict');
      assert.deepEqual(shape(e.detail as never), [{ path: 'lib/f.txt', version: prod('zeta'), original: blobOf(p!, 'f0\n'), delivered: blobOf(p!, 'f1\n'), base: blobOf(p!, 'f other\n'), by: other }]);
      return true;
    });
    // an unrelated version on files of its own composes with the chain, as before
    const apart = await unrelated('con.apart.1', 'other', { 'other/h.txt': 'h1\n' }, ['other/**']);
    const snap = await ctx.actions().snapshot({ mission: M, purpose: 'test', products: [prod('zeta'), apart] });
    assert.deepEqual(filesOf(p, snap.commit, PATHS), expected(ZETA, { 'other/h.txt': 'h1\n' }));
    const all = await ctx.actions().snapshot({ mission: M, purpose: 'test', products: [apart, prod('alpha'), prod('zeta')] });
    assert.deepEqual(filesOf(p, all.commit, PATHS), expected(ZETA, ALPHA, { 'other/h.txt': 'h1\n' }));
  });
});

describe('the manifest takes stacked versions as one line of work', () => {
  it('versions sharing a path or a module are compatible when one rests on the other; the one on top delivers the path', () => {
    const view = new FakeProofView().add(
      fakeObject('b2', { module: 'b', paths: ['b/shared.ts', 'b/new.ts'], prerequisites: [obj('b1')] }),
      fakeObject('b1', { module: 'b', paths: ['b/shared.ts', 'b/old.ts'] }),
      fakeObject('a1', { module: 'b', paths: ['b/shared.ts'], prerequisites: [obj('b2')] }),
      fakeObject('c1', { module: 'b', paths: ['b/shared.ts'] }),
    );
    const r = buildManifest(view, [obj('a1')]);
    assert.equal(r.kind, 'manifest', JSON.stringify(r));
    if (r.kind === 'manifest') assert.equal(r.manifest.paths.get('b/shared.ts'), 'a1', 'a1 rests on b2, which rests on b1');
    const apart = buildManifest(view, [obj('a1'), obj('c1')]);
    assert.equal(apart.kind, 'incompatible', 'c1 rests on none of them');
    if (apart.kind === 'incompatible') assert.deepEqual(apart.conflicts.map((c) => [c.kind, c.path ?? c.module]), [['same-path', 'b/shared.ts'], ['same-module', 'b']]);
  });
});
