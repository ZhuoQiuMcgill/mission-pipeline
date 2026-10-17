// 4.1.2 integration (card INT): the four parts wired through one resolver each, where the wiring is
// observable.
//
//   item 5  `mp pm finish` delivers the plan in effect with the tasks a repair added (P3 planInEffect),
//           and the closing snapshot lists the repair (P3 repairsOf; P4's stub is gone);
//   item 1  the closing snapshot's "proven in an older environment" is P1's resolver
//           (olderEnvironmentProof): an output whose older runs were renewed is no longer listed;
//   item 2  `mp pm full-run` builds its candidate with the delivery itself (candidate-only): with a
//           superseded prerequisite it runs on the very tree `mp pm deliver` delivers;
//   item 3  a delivery writes no candidate files under tmp/ and leaves no scratch; a missing LFS
//           object on an evidence input is objects-unavailable (WI-13), not a crash;
//   item 4  the integration Reviewer card: a failing full suite exits through "rework" with reopen;
//   item 6  the flows read the project's commands from the process context, filled once.

import assert from 'node:assert/strict';
import fs, { existsSync, readdirSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import type { MissionId, ObjectVersionId } from '../src/common/ids.ts';
import type { BaseRecord } from '../src/common/records.ts';
import { olderEnvironmentProof } from '../src/evaluator/index.ts';
import { deliver } from '../src/delivery/delivery.ts';
import type { LabelView } from '../src/delivery/memoryView.ts';
import { writeScopeDocument } from '../src/delivery/writeScope.ts';
import { cal1Pass, cal2Pass, feasible } from '../src/flow/scripted.ts';
import { encodeLfsPointer, lfsPointerFor } from '../src/git/lfs.ts';
import { discoverRepo, lsTree } from '../src/git/objects.ts';
import { readTransformDescription, sha256Hex, transformDescriptionHash } from '../src/git/representation.ts';
import { PlainGit } from '../src/git/plainGit.ts';
import { appendRecords } from '../src/memory/index.ts';
import { openProject } from '../src/cli/project.ts';
import { pmClose, pmDeliver, pmDispatch, pmFinish, pmFullRun, pmNext, pmRenew, pmRepair, pmSay, seatCard, snapshotLines } from '../src/process/index.ts';
import type { SuiteCommand } from '../src/common/fullSuite.ts';
import { commitOn, fixture, IDENT } from './git41-fixtures.ts';
import { addMissionToReview, ENV_A, ENV_B, handBack, processProject, readyOf, reviewerPass, startAddMission, step, write, type ProcessProject } from './process-fixtures.ts';

const M = 'm1' as MissionId;
let p: ProcessProject | null = null;
afterEach(() => {
  p?.cleanup();
  p = null;
});

const obj = (id: string) => ({ kind: 'object' as const, id: id as ObjectVersionId });

/** Every file under `dir`, relative ('' when absent). */
function files(dir: string, rel = ''): string[] {
  if (!existsSync(join(dir, rel))) return [];
  const out: string[] = [];
  for (const e of readdirSync(join(dir, rel), { withFileTypes: true })) {
    const r = rel === '' ? e.name : `${rel}/${e.name}`;
    out.push(r);
    if (e.isDirectory()) out.push(...files(dir, r));
  }
  return out.sort();
}

/** The paths under `root` the fs write functions were called on while `fn` ran (spied through the builtin ESM bindings). */
async function writesUnder<T>(root: string, fn: () => Promise<T>): Promise<{ value: T; writes: string[] }> {
  const names = ['mkdtempSync', 'mkdirSync', 'writeFileSync', 'symlinkSync', 'openSync', 'copyFileSync'] as const;
  const fsx = fs as unknown as Record<string, (...args: unknown[]) => unknown>;
  const orig = new Map(names.map((n) => [n, fsx[n]!]));
  const writes: string[] = [];
  for (const n of names) {
    fsx[n] = (...args: unknown[]) => {
      const target = String(args[0]);
      const flags = n === 'openSync' ? String(args[1] ?? 'r') : 'w';
      if (target.startsWith(root) && flags !== 'r') writes.push(`${n} ${target}`);
      return orig.get(n)!(...args);
    };
  }
  syncBuiltinESMExports();
  try {
    return { value: await fn(), writes };
  } finally {
    for (const n of names) fsx[n] = orig.get(n)!;
    syncBuiltinESMExports();
  }
}

/** The add mission to an accepted, proven product (prod.con.m1.impl.1). */
async function acceptedAdd(o: Parameters<typeof processProject>[0] = {}): Promise<ProcessProject> {
  const q = processProject(o);
  p = q;
  await addMissionToReview(q, M);
  await step(q.ctx, 'reviewer', (c) => reviewerPass(c));
  await pmNext(q.ctx);
  return q;
}

// ---------------------------------------------------------------- item 5: the plan in effect and repairs at the end

describe('INT item 5: finish and close read the plan in effect with its repairs (P3 planInEffect, repairsOf)', () => {
  it('a task a repair added is delivered by mp pm finish and listed at close, with the repair', async () => {
    const q = await acceptedAdd();
    const ctx = q.ctx;
    const w2 = pmSay(ctx, 'Trying it, I miss a subtract function. Please add one.').words;
    const r = await pmRepair(ctx, { mission: M, words: w2, kind: 'missing', text: 'I miss a subtract function' });
    assert.equal(r.repair, 'R-1');
    await step(ctx, 'architect-repair', () => ({
      reopen: [],
      add: [{
        id: 'sub',
        kind: 'implementation',
        module: 'core',
        goal: 'A subtract function with its check',
        standards: [{ id: 'S1', text: 'sub(5, 3) is 2' }],
        requirementItems: [],
        writeScope: ['lib/**'],
        readableFiles: [],
        interpreter: 'node',
        verificationCommands: [{ id: 'check', command: 'node lib/check.js' }],
        implements: [],
        calls: [],
        dependsOn: ['impl'],
        exclusive: [],
        estimate: { durationMs: 60_000, costMicros: 100_000, basis: 'a small function' },
        provenance: 'architect',
      }],
      note: 'subtracting is new work that no task owns',
    }));
    const s = await readyOf(ctx, 'constructor');
    assert.match(s.step, /\.sub\./, 'the added task runs like any task');
    const d = pmDispatch(ctx, s.step);
    write(join(q.dir, d.worktree!), 'lib/sub.js', 'exports.sub = (a, b) => a - b;\n');
    write(join(q.dir, d.worktree!), 'lib/check.js', "const { sub } = require('./sub.js'); console.log(sub(5, 3) === 2 ? 'ok 1 - subtracts' : 'not ok 1'); process.exit(sub(5, 3) === 2 ? 0 : 1);\n");
    const a = await handBack(ctx, d.dispatch, { done: 'implemented sub', unmet_standards: [], unfixed_problems: [], decisions_needed: [] });
    assert.equal(a.kind, 'recorded', JSON.stringify(a));
    await step(ctx, 'reviewer', (c) => reviewerPass(c));

    const w3 = pmSay(ctx, 'Looks good: close and merge.').words;
    const f = await pmFinish(ctx, { mission: M, words: w3 });
    assert.deepEqual(f.outputs.map((t) => t.id).sort(), ['prod.con.m1.impl.1', 'prod.con.m1.sub.1'], 'the default outputs include the task the repair added');
    assert.equal(f.delivery?.result.kind, 'delivered');
    assert.equal(f.landing?.kind, 'landed');
    assert.equal(q.git('show', 'refs/heads/main:lib/sub.js'), 'exports.sub = (a, b) => a - b;');
    const snap = f.close!.doc;
    assert.equal(snap.proof.find((x) => x.object === 'prod.con.m1.sub.1')?.label, 'proven', 'the repair-added output is listed with its label');
    assert.deepEqual(snap.repairs.map((x) => [x.repair, x.kind, x.words, x.text, x.state, x.added, x.reopened]), [['R-1', 'missing', w2, 'I miss a subtract function', 'decided', ['sub'], []]], 'the repair, through P3\'s resolver');
    assert.ok(snapshotLines(snap).includes(`Repairs: R-1 (missing, ${w2}): I miss a subtract function [decided; added sub]`), snapshotLines(snap).join('\n'));
  });
});

// ---------------------------------------------------------------- item 1: "older environment" at close

describe('INT item 1: the close labels older-environment outputs through P1\'s resolver (olderEnvironmentProof)', () => {
  it('an output proven on runs recorded under an older environment identity is listed (it stays proven)', async () => {
    const q = await acceptedAdd();
    const ctx = q.reopen(ENV_B);
    ctx.environment();
    assert.ok(ctx.memory.read((db) => olderEnvironmentProof(db).targets).has('prod.con.m1.impl.1'));
    const c = await pmClose(ctx, M, { mode: 'with-risk' });
    assert.deepEqual(c.doc.olderEnvironment, ['prod.con.m1.impl.1']);
    assert.equal(c.doc.proof.find((x) => x.object === 'prod.con.m1.impl.1')?.label, 'proven');
    assert.ok(c.risks.includes('proven in an older environment: prod.con.m1.impl.1'));
  });

  it('once mp pm renew reran those runs under the current identity, the output is no longer listed', async () => {
    const q = await acceptedAdd();
    const ctx = q.reopen(ENV_B);
    const renewed = await pmRenew(ctx);
    assert.ok(renewed.reruns.length > 0, JSON.stringify(renewed));
    assert.equal(ctx.memory.read((db) => olderEnvironmentProof(db).targets).size, 0, 'the resolver: no proof rests on an older run');
    const c = await pmClose(ctx, M, { mode: 'with-risk' });
    assert.equal(c.doc.proof.find((x) => x.object === 'prod.con.m1.impl.1')?.label, 'proven');
    assert.deepEqual(c.doc.olderEnvironment, [], 'the close reads the same resolver: the replaced run is not the evidence in force');
  });
});

// ---------------------------------------------------------------- item 2 (+4): one candidate builder for full runs

/** A detailed plan of element e1: iface (a/), impl (b/, on iface), and an integration task that writes nothing. */
function reopenPlan(): unknown {
  const task = (id: string, kind: 'implementation' | 'integration', dir: string, o: { dependsOn?: string[]; readOnly?: boolean; implementsAdd?: boolean } = {}) => ({
    id,
    kind,
    module: o.readOnly === true ? null : 'core',
    goal: o.readOnly === true ? 'Check the parts together' : `Task ${id}`,
    standards: [{ id: 'S1', text: 'its check passes' }],
    requirementItems: [`item.${M}.g1`],
    writeScope: o.readOnly === true ? [] : [`${dir}/**`],
    readableFiles: ['README.md'],
    interpreter: 'node',
    verificationCommands: [{ id: 'check', command: `node ${dir}/check.js` }],
    implements: o.implementsAdd === true ? ['add'] : [],
    calls: [],
    dependsOn: o.dependsOn ?? [],
    exclusive: [],
    estimate: { durationMs: 60_000, costMicros: 100_000, basis: 'small' },
    provenance: { planElement: 'e1' },
  });
  return {
    reusedInterfaces: [],
    newInterfaces: [{ name: 'add', definition: 'add(a: number, b: number): number', searched: 'searched the repository: no arithmetic helpers exist', provenance: { planElement: 'e1' } }],
    modules: [{ id: 'core', writeScope: ['a/**', 'b/**'], provenance: { planElement: 'e1' } }],
    tasks: [task('iface', 'implementation', 'a', { implementsAdd: true }), task('impl', 'implementation', 'b', { dependsOn: ['iface'] }), task('integ', 'integration', 'a', { dependsOn: ['iface', 'impl'], readOnly: true })],
    risks: [],
  };
}

async function construct(q: ProcessProject, dir: string, add: string): Promise<void> {
  const s = await readyOf(q.ctx, 'constructor');
  const d = pmDispatch(q.ctx, s.step);
  write(join(q.dir, d.worktree!), `${dir}/add.js`, add);
  write(join(q.dir, d.worktree!), `${dir}/check.js`, "console.log('ok 1 - adds'); process.exit(0);\n");
  const a = await handBack(q.ctx, d.dispatch, { done: 'done', unmet_standards: [], unfixed_problems: [], decisions_needed: [] });
  if (a.kind !== 'recorded') throw new Error(JSON.stringify(a));
}

const SUITE: SuiteCommand[] = [{ id: 'all', command: 'node a/check.js && node b/check.js' }];

describe('INT item 2: mp pm full-run builds its candidate with the delivery itself (candidate-only)', () => {
  it('with a prerequisite superseded by a reopen, the full run runs on the tree mp pm deliver delivers; the integration card exits a failing suite through rework + reopen', async () => {
    const q = processProject({ options: { fullSuite: SUITE } });
    p = q;
    const ctx = q.ctx;
    await startAddMission(ctx, M);
    await step(ctx, 'calibrator-1', (c) => cal1Pass(c));
    await step(ctx, 'architect-decompose', () => reopenPlan());
    if ((await pmNext(ctx)).ready.some((r) => r.kind === 'architect-feasibility')) await step(ctx, 'architect-feasibility', () => feasible());
    await step(ctx, 'calibrator-2', (c) => cal2Pass(c));
    await construct(q, 'a', 'exports.add = (a, b) => a + b;\n');
    await step(ctx, 'reviewer', (c) => reviewerPass(c));
    await construct(q, 'b', 'exports.twice = (a) => a + a;\n');
    await step(ctx, 'reviewer', (c) => reviewerPass(c));
    // the integration task writes nothing: its Reviewer judges the start snapshot, and reopens iface (D-6)
    await step(ctx, 'reviewer', (c, dispatch) => {
      assert.ok(c.integration !== undefined, 'an integration card');
      const text = seatCard(ctx, dispatch).text;
      assert.match(text, new RegExp(`mp seat ${dispatch} full-run`), 'the full run is offered (a full suite is configured)');
      assert.match(text, /When the full suite fails, trace the failure[^\n]*hand back "rework" with `reopen`/);
      assert.match(text, /Hand back "needs-decision" only for a failure no dependency explains/);
      assert.doesNotMatch(text, /name that task in your findings and hand back "needs-decision"/);
      return {
        ...(reviewerPass(c) as Record<string, unknown>),
        judgments: c.standards.map((s: { id: string }) => ({ standard: s.id, met: 'no', reason: 'the interface misses an option', evidence: c.verificationRuns.map((r: { evidence: string }) => `evidence:${r.evidence}`) })),
        verdict: 'rework',
        reopen: [{ task: 'iface', issue: 'add must not depend on argument order' }],
      };
    });
    await construct(q, 'a', 'exports.add = (a, b) => b + a;\n');
    await step(ctx, 'reviewer', (c) => reviewerPass(c));
    const A2 = 'prod.con.m1.iface.2';
    const B1 = 'prod.con.m1.impl.1';
    const words = pmSay(ctx, 'Run the whole suite once more, then deliver it.').words;
    const run = await pmFullRun(ctx, { mission: M, words, reason: 'iface was reopened after the integration review', outputs: [obj(A2), obj(B1)] });
    assert.equal(run.marker.passed, true, JSON.stringify(run.marker));
    assert.match(q.git('log', '-1', '--format=%s', run.candidate), /^Delivery full-run-candidate of mission m1/, 'the delivery built it (candidate-only)');
    const del = await pmDeliver(ctx, { mission: M, delivery: 'v1', selected: [obj(A2), obj(B1)], words });
    assert.equal(del.kind, 'delivered', JSON.stringify(del).slice(0, 500));
    if (del.kind !== 'delivered') return;
    assert.equal(del.record.tree, run.marker.tree, 'the same tree: the manifest and its superseded prerequisite are composed the same way');
    assert.match(del.record.fullRun?.line ?? '', /on this tree: passed/);
    // P3's rule applied to both: impl.1 was built on iface.1 and is delivered with iface.2
    assert.deepEqual(del.record.proof?.notFullyProven.find((n) => n.id === B1)?.reasons, [{ kind: 'built-on-superseded', prerequisite: 'prod.con.m1.iface.1', deliveredWith: A2 }]);
  });
});

// ---------------------------------------------------------------- item 3: no unread trees at delivery

describe('INT item 3: a delivery materializes nothing (P2 materialize none, owned scratch)', () => {
  it('a delivery writes no candidate file under tmp/ and leaves no scratch or owner lock behind', async () => {
    const q = await acceptedAdd();
    const ctx = q.ctx;
    const words = pmSay(ctx, 'Deliver it.').words;
    const tmp = ctx.memory.paths.tmp;
    const { value: r, writes } = await writesUnder(join(q.dir, '.mission-pipeline'), () => pmDeliver(ctx, { mission: M, delivery: 'v1', selected: [obj('prod.con.m1.impl.1')], words }));
    assert.equal(r.kind, 'delivered', JSON.stringify(r).slice(0, 500));
    assert.ok(writes.some((w) => w.includes('/tmp/deliver-')), `the spy sees the delivery's owned scratch: ${writes.join('\n')}`);
    const tree = writes.filter((w) => w.includes('/tmp/') && (/\/candidate-/.test(w) || /\/src\/(add|check)\.js$/.test(w)));
    assert.deepEqual(tree, [], 'no candidate tree is written');
    assert.deepEqual(files(tmp).filter((x) => x.startsWith('deliver-')), [], 'its scratch is removed');
    assert.deepEqual(files(join(ctx.memory.paths.locks, 'owners')).filter((x) => x.startsWith('deliver-')), [], 'and its owner lock');
  });

  it('a missing LFS object on an evidence input: objects-unavailable with WI-13, nothing delivered, no crash', async () => {
    const f = fixture({ files: { '.gitattributes': '*.bin filter=lfs diff=lfs merge=lfs -text\n', 'src/a.txt': 'a\n' } });
    try {
      const big = randomBytes(2000);
      const pointer = encodeLfsPointer(lfsPointerFor(big)).toString('utf8');
      // the pointer is committed; the LFS object itself is not in .git/lfs/objects
      const commit = commitOn(f.dir, f.base, { 'src/big.bin': pointer }, 'an LFS file');
      const repo = await discoverRepo(f.ctx.git, f.dir);
      const transform = transformDescriptionHash(await readTransformDescription(f.ctx.git, repo, f.dir));
      const scopeDoc = writeScopeDocument(await lsTree(f.ctx.git, repo, commit, { recursive: true }), ['src/**']);
      f.m.write({}, (tx) => {
        appendRecords(tx, [{ kind: 'object.version', object: 'o1', objectKind: 'product', mission: M, module: 'mod-o1', content: tx.data.put(scopeDoc), prerequisites: tx.data.putList([]), scope: { paths: ['src/big.bin'], taskType: 'construct' }, reviews: [{ review: 'reviewer', basisLines: [], reliesOn: [] }], source: { commit, writeScope: ['src/**'], transform } } as unknown as BaseRecord]);
      });
      const labels: LabelView = { revision: f.m.head(), recomputing: false, labelOf: () => 'proven', decidingRuns: () => [{ evidence: 'run-o1' as never, fields: { 'input:src/big.bin': sha256Hex(big) } }], recomputingIn: () => false };
      const r = await deliver(f.ctx, { mission: M, delivery: 'd1', targetBranch: 'main', selected: [obj('o1')], author: IDENT, committer: IDENT }, { labels });
      assert.equal(r.kind, 'objects-unavailable', JSON.stringify(r).slice(0, 500));
      const alerts = (f.m.stmt("SELECT record FROM log WHERE kind = 'alert'").all() as Array<{ record: string }>).map((x) => x.record).filter((x) => x.includes('"WI-13"'));
      assert.equal(alerts.length, 1);
      assert.throws(() => f.git('rev-parse', '--verify', 'refs/mission-pipeline/delivered/m1/d1'), 'no delivery ref');
      assert.deepEqual(files(f.m.paths.tmp).filter((x) => x.startsWith('deliver-')), [], 'its scratch is removed');
    } finally {
      f.cleanup();
    }
  });
});

// ---------------------------------------------------------------- item 6: one source for the project's commands

describe('INT item 6: the flows read the project\'s commands from the process context', () => {
  it('the flows\' ports carry the context\'s full suite and local commands (one read of the config)', () => {
    const local: SuiteCommand[] = [{ id: 'unit', command: 'npm run unit' }];
    const q = processProject({ options: { fullSuite: SUITE, localCommands: local } });
    p = q;
    const project = q.ctx.ports().project;
    assert.equal(project?.fullSuite, q.ctx.fullSuite, 'the very suite P1 reads (ProcessContext.fullSuite)');
    assert.deepEqual(project?.fullSuite, SUITE);
    assert.deepEqual(project?.localCommands, local);
  });

  it('from config.json: closingChecks read as the alias reaches the context and the flows alike', async () => {
    const q = processProject();
    p = q;
    writeFileSync(join(q.dir, '.mission-pipeline', 'config.json'), JSON.stringify({ format: 'mp41.config.v1', targetBranch: 'main', verificationCommands: [{ id: 'unit', command: 'node t.js' }], closingChecks: [{ id: 'all', command: 'npm test' }] }));
    q.ctx.memory.close();
    const proj = await openProject({ cwd: q.dir, env: { MP_PROJECT: '' }, process: { observe: () => ENV_A, git: PlainGit.create() } }, { flag: null, decides: false });
    try {
      assert.deepEqual(proj.ctx.fullSuite, [{ id: 'all', command: 'npm test' }]);
      assert.equal(proj.ctx.ports().project?.fullSuite, proj.ctx.fullSuite);
      assert.deepEqual(proj.ctx.ports().project?.localCommands, [{ id: 'unit', command: 'node t.js' }]);
    } finally {
      proj.ctx.memory.close();
      q.reopen();
    }
  });
});
