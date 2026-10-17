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
//   item 6  the flows read the project's commands from the process context, filled once;
//   review F1  the program never runs the full suite at hand-back or in the flow (a 4.1.1 plan, an
//           integration task, a card in flight): the integration Reviewer's full-run does, with a
//           marker; rule 7 covers integration tasks;
//   review F2  the flow's verification waits while a stop covers the work, and resumes after it;
//   review G1  the closing snapshot lists the plan in effect: a task a re-plan dropped is history.

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
import { encodeLfsPointer, lfsPointerFor } from '../src/git/lfs.ts';
import { discoverRepo, lsTree } from '../src/git/objects.ts';
import { readTransformDescription, sha256Hex, transformDescriptionHash } from '../src/git/representation.ts';
import { PlainGit } from '../src/git/plainGit.ts';
import { appendRecords } from '../src/memory/index.ts';
import { openProject } from '../src/cli/project.ts';
import { dispatchView } from '../src/process/seat.ts';
import { fullRunMarkers, pmClose, pmDeliver, pmDispatch, pmFinish, pmFullRun, pmNext, pmRenew, pmRepair, pmSay, pmStop, recordSeatHandBack, seatCard, seatFullRun, seatRerun, shellRunner, snapshotLines, type CommandRunner, type ProcessContext } from '../src/process/index.ts';
import { flowEvents, releaseStop } from '../src/memory/index.ts';
import { mechanicalCheck } from '../src/flow/mechanical.ts';
import { FlowEngine } from '../src/flow/engine.ts';
import { flowCtx } from '../src/flow/context.ts';
import { planInEffect, submitPmBatch } from '../src/flow/planning.ts';
import { cal1Pass, cal2Pass, detailedPlan, drive, feasible, happyScript, pmPlan, seedMission, SEED_TEXT } from '../src/flow/scripted.ts';
import { memoryPorts, say } from './flow-memory-fixtures.ts';
import type { SuiteCommand } from '../src/common/fullSuite.ts';
import { commitOn, fixture, IDENT } from './git41-fixtures.ts';
import { addDetailedPlan, addMissionToReview, CHECK_JS, ENV_A, ENV_B, handBack, processProject, readAll, readyOf, reviewerPass, startAddMission, step, write, type ProcessProject } from './process-fixtures.ts';

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

// ---------------------------------------------------------------- review F1: the full suite never runs at hand-back

/** A runner that records every command it executes (and fails them while `interrupt` is set: a killed run). */
function recording(): { readonly runner: CommandRunner; readonly calls: string[]; interrupt: boolean } {
  const r = {
    calls: [] as string[],
    interrupt: false,
    runner: ((req) => {
      if (r.interrupt) throw new Error('the run was interrupted');
      r.calls.push(req.command);
      return shellRunner(req);
    }) as CommandRunner,
  };
  return r;
}

const ADD_SUITE: SuiteCommand[] = [{ id: 'all', command: 'node src/check.js --all' }];

/**
 * The add mission planned as 4.1.1 plans were: its task lists the project's suite next to its own
 * check (no rule refused it then); the suite is configured from the Constructor's dispatch on.
 */
async function legacyPlanned(rec: ReturnType<typeof recording>): Promise<ProcessProject> {
  const q = processProject({ options: { runner: rec.runner } });
  p = q;
  await startAddMission(q.ctx, M);
  await step(q.ctx, 'calibrator-1', (c) => cal1Pass(c));
  await step(q.ctx, 'architect-decompose', () => addDetailedPlan(M, { verification: [{ id: 'check', command: 'node src/check.js' }, { id: 'all', command: 'node src/check.js --all' }] }));
  await step(q.ctx, 'calibrator-2', (c) => cal2Pass(c));
  q.reopen(ENV_A, { fullSuite: ADD_SUITE });
  return q;
}

function verifiedOf(ctx: ProcessContext, task: string): Array<{ runs: Array<{ command: string }> }> {
  return ctx.memory.read((db) => flowEvents(db, { mission: M, line: `task:${task}`, event: 'verified', limit: 100 }).map((e) => JSON.parse(ctx.memory.data.text(e.body)) as { runs: Array<{ command: string }> }));
}

describe('INT review F1: the program never runs the full suite at hand-back or in the flow (D-4, D-5, D-7)', () => {
  it('a 4.1.1-shape plan with the suite on an ordinary task: the hand-back runs only its other commands; the cards leave the suite to the integration review', async () => {
    const rec = recording();
    const q = await legacyPlanned(rec);
    const ctx = q.ctx;
    const s = await readyOf(ctx, 'constructor');
    const d = pmDispatch(ctx, s.step);
    const card = seatCard(ctx, d.dispatch).text;
    assert.match(card, /## The project's full suite\n\[all\] node src\/check\.js --all on this card is the project's full suite\. `mp` does not run it at hand-back[^\n]*left to the integration review[^\n]*Do not run it yourself/);
    write(join(q.dir, d.worktree!), 'src/add.js', 'exports.add = (a, b) => a + b;\n');
    write(join(q.dir, d.worktree!), 'src/check.js', CHECK_JS);
    const a = await handBack(ctx, d.dispatch, { done: 'implemented add', unmet_standards: [], unfixed_problems: [], decisions_needed: [] });
    assert.equal(a.kind, 'recorded', JSON.stringify(a));
    if (a.kind !== 'recorded') return;
    assert.deepEqual(a.verification?.map((r) => r.command), ['node src/check.js'], 'only the task\'s own check ran');
    assert.ok(a.notes.some((n) => n.startsWith('all is the project\'s full suite: not run at hand-back')), a.notes.join('\n'));
    await pmNext(ctx);
    assert.deepEqual(rec.calls, ['node src/check.js'], 'neither the hand-back nor the flow ran the suite');
    assert.deepEqual(verifiedOf(ctx, 'impl').map((v) => v.runs.map((r) => r.command)), [['node src/check.js']]);
    // the Reviewer may not rerun it either; its card says why
    const rs = await readyOf(ctx, 'reviewer');
    const rd = pmDispatch(ctx, rs.step);
    const rcard = seatCard(ctx, rd.dispatch).text;
    assert.match(rcard, /rerun <command-id>`: `mp` runs a declared command \(ids: check\)/);
    assert.match(rcard, /\[all\] node src\/check\.js --all on this card is the project's full suite/);
    await assert.rejects(seatRerun(ctx, rd.dispatch, 'all'), (e: { code?: string; message?: string }) => e.code === 'NOT_ALLOWED' && /the project's full suite: it is not rerun from a card; it is left to the integration review/.test(e.message ?? ''));
    assert.deepEqual(rec.calls, ['node src/check.js']);
    // the close says honestly that it never ran
    const c = await pmClose(ctx, M, { mode: 'with-risk' });
    assert.equal(c.doc.fullRun, null, 'no delivery: nothing claims a full run');
    assert.equal(ctx.memory.read((db) => fullRunMarkers(db, ctx.memory.data, M)).length, 0);
  });

  it('an integration task declaring the suite: its hand-back does not run it; its Reviewer\'s full-run does, once, with a marker', async () => {
    const rec = recording();
    const q = processProject({ options: { runner: rec.runner } });
    p = q;
    const ctx0 = q.ctx;
    await startAddMission(ctx0, M);
    await step(ctx0, 'calibrator-1', (c) => cal1Pass(c));
    const plan = addDetailedPlan(M) as { tasks: Array<Record<string, unknown>>; modules: Array<Record<string, unknown>> };
    const SUITE_ALL: SuiteCommand[] = [{ id: 'all', command: 'node src/check.js && node c/check.js' }];
    plan.modules = [{ ...plan.modules[0], writeScope: ['src/**', 'c/**'] }];
    plan.tasks.push({ ...plan.tasks[0], id: 'integ', kind: 'integration', goal: 'Integrate', implements: [], writeScope: ['c/**'], dependsOn: ['impl'], verificationCommands: [{ id: 'check', command: 'node c/check.js' }, { id: 'all', command: SUITE_ALL[0]!.command }] });
    await step(ctx0, 'architect-decompose', () => plan);
    if ((await pmNext(ctx0)).ready.some((r) => r.kind === 'architect-feasibility')) await step(ctx0, 'architect-feasibility', () => feasible());
    await step(ctx0, 'calibrator-2', (c) => cal2Pass(c));
    const ctx = q.reopen(ENV_A, { fullSuite: SUITE_ALL });
    const s1 = await readyOf(ctx, 'constructor');
    const d1 = pmDispatch(ctx, s1.step);
    write(join(q.dir, d1.worktree!), 'src/add.js', 'exports.add = (a, b) => a + b;\n');
    write(join(q.dir, d1.worktree!), 'src/check.js', CHECK_JS);
    assert.equal((await handBack(ctx, d1.dispatch, { done: 'add', unmet_standards: [], unfixed_problems: [], decisions_needed: [] })).kind, 'recorded');
    await step(ctx, 'reviewer', (c) => reviewerPass(c));
    const s2 = await readyOf(ctx, 'constructor');
    assert.match(s2.step, /\.integ\./);
    const d2 = pmDispatch(ctx, s2.step);
    write(join(q.dir, d2.worktree!), 'c/check.js', "console.log('ok 1 - integrated'); process.exit(0);\n");
    const a = await handBack(ctx, d2.dispatch, { done: 'integrated', unmet_standards: [], unfixed_problems: [], decisions_needed: [] });
    assert.equal(a.kind, 'recorded', JSON.stringify(a));
    if (a.kind !== 'recorded') return;
    assert.deepEqual(a.verification?.map((r) => r.command), ['node c/check.js'], 'the integration hand-back ran its own check only');
    await pmNext(ctx);
    assert.equal(rec.calls.filter((c) => c === SUITE_ALL[0]!.command).length, 0, 'the suite has not run');
    // its Reviewer runs the suite, last, with mp seat <id> full-run: one execution, one marker
    const rs = await readyOf(ctx, 'reviewer');
    const rd = pmDispatch(ctx, rs.step);
    readAll(ctx, rd.dispatch);
    assert.match(seatCard(ctx, rd.dispatch).text, new RegExp(`you run the suite with \`mp seat ${rd.dispatch} full-run\`, last`));
    const fr = await seatFullRun(ctx, rd.dispatch);
    assert.equal(fr.marker.passed, true, JSON.stringify(fr.marker));
    assert.equal(rec.calls.filter((c) => c === SUITE_ALL[0]!.command).length, 1, 'the full run executed it once');
    const card = dispatchView(ctx, rd.dispatch).card as unknown as Parameters<typeof reviewerPass>[0];
    const ans = await handBack(ctx, rd.dispatch, reviewerPass(card, fr.marker.commands.map((x) => `evidence:${x.evidence}`)));
    assert.equal(ans.kind, 'recorded', JSON.stringify(ans));
    await pmNext(ctx);
    const markers = ctx.memory.read((db) => fullRunMarkers(db, ctx.memory.data, M));
    assert.deepEqual(markers.map((m) => [m.by, m.passed, m.cites.dispatch]), [['reviewer', true, rd.dispatch]], 'the run is recorded with its marker');
  });

  it('rule 7 refuses the suite on an integration task in a new plan', async () => {
    const base = detailedPlan(M, { extraTask: true });
    const plan = { ...base, tasks: base.tasks.map((t) => (t.id === 'docs' ? { ...t, verificationCommands: [{ id: 'all', command: 'node   src/check.js --all' }] } : t)) };
    const r = await mechanicalCheck({ pmPlan: pmPlan(M), plan, unsettled: new Set(), hasSymbol: async () => true, fullSuite: ADD_SUITE });
    assert.deepEqual(r.failures, ['full suite: task docs (integration) lists the full suite as a verification command: its Reviewer runs the suite with `mp seat <id> full-run`, last; give the task the project\'s local commands (D-5).']);
    const ok = await mechanicalCheck({ pmPlan: pmPlan(M), plan: base, unsettled: new Set(), hasSymbol: async () => true, fullSuite: ADD_SUITE });
    assert.deepEqual(ok.failures, []);
  });
});

// ---------------------------------------------------------------- review F2: a stop stops the flow's verification

describe('INT review F2: the flow\'s verification waits while a stop covers the work (§6.6)', () => {
  it('a recorded hand-back whose runs were interrupted: under a stop mp pm next executes nothing; after the release it runs them', async () => {
    const rec = recording();
    const q = await legacyPlanned(rec);
    const ctx = q.ctx;
    const s = await readyOf(ctx, 'constructor');
    const d = pmDispatch(ctx, s.step);
    write(join(q.dir, d.worktree!), 'src/add.js', 'exports.add = (a, b) => a + b;\n');
    write(join(q.dir, d.worktree!), 'src/check.js', CHECK_JS);
    rec.interrupt = true;
    const a = await recordSeatHandBack(ctx, d.dispatch, { report: '# done\n', fields: { done: 'implemented add', unmet_standards: [], unfixed_problems: [], decisions_needed: [] }, advance: false });
    rec.interrupt = false;
    assert.equal(a.kind, 'recorded', JSON.stringify(a));
    assert.deepEqual(verifiedOf(ctx, 'impl'), [], 'no verified event: the runs were interrupted');
    pmStop(ctx, { stop: 'stop-all' as never, scope: { kind: 'all' }, words: 'stop everything', wordsEntry: null });
    const held = await pmNext(ctx);
    assert.deepEqual(rec.calls, [], 'nothing executed under the stop');
    assert.deepEqual(verifiedOf(ctx, 'impl'), []);
    assert.deepEqual(held.errors, [], 'a wait, not an error');
    ctx.memory.write({ op: 'release:stop-all', payload: {}, stop: true }, (tx) => releaseStop(tx, 'stop-all' as never));
    await pmNext(ctx);
    assert.deepEqual(rec.calls, ['node src/check.js'], 'released: the runs execute (never the suite)');
    assert.deepEqual(verifiedOf(ctx, 'impl').map((v) => v.runs.map((r) => r.command)), [['node src/check.js']]);
    assert.equal((await readyOf(ctx, 'reviewer')).kind, 'reviewer', 'the task goes on to its Reviewer');
  });
});

// ---------------------------------------------------------------- review G1: the close lists the plan in effect

describe('INT review G1: the closing snapshot lists the plan in effect, not every plan that ever took effect', () => {
  it('a task a re-plan dropped before it was done is history, not unfinished work', async () => {
    const ports = memoryPorts();
    say(ports, SEED_TEXT);
    await seedMission(ports, M);
    await submitPmBatch(ports, { mission: M, plan: pmPlan(M), userWords: ['W-1'], mode: 'fast' });
    const engine = new FlowEngine(ports);
    const v1 = detailedPlan(M, { extraTask: true });
    let current = v1;
    const script = happyScript(M, () => current);
    // the docs task's Constructor never hands back: it is unfinished when the re-plan drops it
    const holdDocs = (t: Parameters<typeof script>[0], sch: Parameters<typeof script>[1]) => (t.card.seat === 'constructor' && t.task.includes('.docs.') ? null : script(t, sch));
    await drive(engine, ports.scheduler, holdDocs);
    const changed = pmPlan(M);
    await submitPmBatch(ports, { mission: M, plan: { ...changed, elements: changed.elements.map((e) => (e.id === 'e2' ? { ...e, text: 'Covered by unit tests, all of them' } : e)) }, userWords: ['W-1'], mode: 'fast' });
    current = detailedPlan(M);
    await drive(engine, ports.scheduler, holdDocs);
    const inEffect = await planInEffect(flowCtx(ports, M));
    assert.deepEqual(inEffect?.plan.tasks.map((t) => t.id), ['iface', 'impl'], 'the re-plan dropped docs');
    const c = await pmClose(ports.ctx, M, { mode: 'with-risk' });
    assert.ok(!c.doc.unfinished.planTasks.includes('docs'), JSON.stringify(c.doc.unfinished));
    assert.ok(!c.risks.some((r) => r.includes('plan task docs')), c.risks.join('\n'));
    assert.deepEqual(c.doc.proof.filter((x) => x.kind === 'product').map((x) => x.of).sort(), ['task iface', 'task impl']);
  });
});
