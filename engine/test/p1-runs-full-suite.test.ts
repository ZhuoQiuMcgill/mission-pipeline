// 4.1.2 part P1: runs and the full suite (design DesignDoc_ExecutionRedundancy v01, D-1, D-4..D-8).
//
//   1  one hand-back runs each command once: its runs are the flow's "verified" event of that
//      attempt; a `network: true` command executes once per hand-back; when the hand-back and the
//      flow reach the event together, the first writer wins and the other adopts it
//   3  `fullSuite` (config.json), `closingChecks` read as its alias, `mp config` says which
//   4  the integration Reviewer: `mp seat <id> full-run` (last); a pass cites a passing full run;
//      a full run on an identical tree is reused; non-integration cards never offer it
//   5  full-run markers and fullRunStatus (sameTree, changedSince after a later accepted product)
//   6  `mp pm full-run`: refused without words or an authorization; the marker cites them
//   7  a failing full run keeps the last 400 lines (at most 64 KiB) of each failing command
//   8  an environment change: proof stays (labelled "older environment"), stable mode does not
//      wait, `mp pm next` offers no renew step (one notice)

import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { buildGraph } from '../src/cli/tree.ts';
import { openProject } from '../src/cli/project.ts';
import { fullSuiteOf, isFullSuiteCommand } from '../src/common/fullSuite.ts';
import type { MissionId } from '../src/common/ids.ts';
import { decisionLabels, renewalCandidates } from '../src/evaluator/index.ts';
import { cal1Pass, cal2Pass, feasible } from '../src/flow/scripted.ts';
import { PlainGit } from '../src/git/plainGit.ts';
import { flowEvents } from '../src/memory/index.ts';
import {
  advance,
  cardForSeat,
  FULL_RUN_TAIL,
  fullRunMarkers,
  fullRunStatus,
  gitActions,
  LOCAL_TAIL,
  openProcess,
  pmDispatch,
  pmFullRun,
  pmNext,
  pmRenew,
  pmStop,
  runFullSuite,
  runOnCommit,
  seatCard,
  seatFullRun,
  seatRerun,
  suiteHash,
  shellRunner,
  tail,
  treeOf,
  type CommandRunner,
  type GitActions,
  type ProcessContext,
} from '../src/process/index.ts';
import { dispatchView, recordVerified } from '../src/process/seat.ts';
import type { VerificationRun } from '../src/flow/ports.ts';
import { cli } from './cli-fixtures.ts';
import { addDetailedPlan, addMissionToReview, CHECK_JS, ENV_A, ENV_B, handBack, processProject, readAll, readyOf, reviewerPass, startAddMission, step, write, type ProcessProject } from './process-fixtures.ts';

const M = 'm1';
const NET = `node -e "console.log('ok 1 - reached the network')"`;
const SUITE = [{ id: 'suite', command: 'node suite.js' }];
const SUITE_JS = "const { add } = require('./src/add.js');\nconsole.log('TAP version 13');\nconsole.log(add(2, 3) === 5 ? 'ok 1 - the whole suite' : 'not ok 1 - the whole suite');\nprocess.exit(add(2, 3) === 5 ? 0 : 1);\n";
const IDENT = { name: 'mp test', email: 'mp@test' };

let p: ProcessProject | null = null;
afterEach(() => {
  const q = p;
  p = null;
  q?.cleanup();
});

/** A runner that counts the executions of each command line. */
function counting(): { readonly runner: CommandRunner; count(command: string): number } {
  const n = new Map<string, number>();
  return {
    runner: (req) => {
      n.set(req.command, (n.get(req.command) ?? 0) + 1);
      return shellRunner(req);
    },
    count: (c) => n.get(c) ?? 0,
  };
}

function planWithNetwork(): unknown {
  const dp = addDetailedPlan(M) as { tasks: Array<{ verificationCommands: unknown[] }> };
  dp.tasks[0]!.verificationCommands = [{ id: 'check', command: 'node src/check.js' }, { id: 'net', command: NET, network: true }];
  return dp;
}

/** Two tasks: impl (src/**) and integ, the integration task (app/**), which depends on impl. */
function integrationPlan(): unknown {
  const dp = addDetailedPlan(M) as { tasks: unknown[] };
  dp.tasks.push({
    id: 'integ',
    kind: 'integration',
    module: null,
    goal: 'Use add in the app',
    standards: [{ id: 'S1', text: 'the app prints add(2, 3)' }],
    requirementItems: [`item.${M}.g1`],
    writeScope: ['app/**'],
    readableFiles: ['README.md'],
    interpreter: 'node',
    verificationCommands: [{ id: 'app', command: 'node app/main.js' }],
    implements: [],
    calls: ['add'],
    dependsOn: ['impl'],
    exclusive: [],
    estimate: { durationMs: 60_000, costMicros: 100_000, basis: 'a small change' },
    provenance: { planElement: 'e1' },
  });
  return dp;
}

const evidenceOf = (ctx: ProcessContext, command: string): string[] =>
  ctx.memory.read((db) => (db.stmt("SELECT json_extract(record, '$.evidence') AS e FROM log WHERE kind = 'evidence' AND json_extract(record, '$.fields.command') = ? ORDER BY rev").all(command) as Array<{ e: string }>).map((r) => r.e));

const verifiedEvents = (ctx: ProcessContext, task: string): Array<{ key: string; runs: VerificationRun[] }> =>
  ctx.memory.read((db) => flowEvents(db, { mission: M as MissionId, line: `task:${task}`, event: 'verified' })).map((e) => ({ key: e.key, runs: (JSON.parse(ctx.memory.data.text(e.body)) as { runs: VerificationRun[] }).runs }));

const alerts = (ctx: ProcessContext): string[] => ctx.memory.read((db) => (db.stmt("SELECT json_extract(record, '$.category') AS c FROM log WHERE kind = 'alert' ORDER BY rev").all() as Array<{ c: string }>).map((r) => r.c));

/** The mission planned with `detailed` (feasibility when it asks), up to the first Constructor's step. */
async function planned(pp: ProcessProject, detailed: unknown): Promise<void> {
  await startAddMission(pp.ctx, M);
  await step(pp.ctx, 'calibrator-1', (c) => cal1Pass(c));
  await step(pp.ctx, 'architect-decompose', () => detailed);
  if ((await pmNext(pp.ctx)).ready.some((r) => r.kind === 'architect-feasibility')) await step(pp.ctx, 'architect-feasibility', () => feasible());
  await step(pp.ctx, 'calibrator-2', (c) => cal2Pass(c));
}

/** A Constructor attempt of `task`: its files written in its worktree, handed back; the candidate commit. */
async function construct(pp: ProcessProject, task: string, files: Readonly<Record<string, string>>): Promise<string> {
  const next = await pmNext(pp.ctx);
  const s = next.ready.find((r) => r.kind === 'constructor' && r.step.includes(`.${task}.`));
  assert.ok(s !== undefined, `no ready constructor of ${task}: ${next.ready.map((r) => r.step).join(', ')}; held: ${next.held.map((h) => `${h.step}: ${h.why}`).join('; ')}`);
  const d = pmDispatch(pp.ctx, s.step);
  const wt = join(pp.dir, d.worktree!);
  for (const [rel, text] of Object.entries(files)) write(wt, rel, text);
  const a = await handBack(pp.ctx, d.dispatch, { done: 'done', unmet_standards: [], unfixed_problems: [], decisions_needed: [] });
  assert.ok(a.kind === 'recorded' && a.candidate !== null, JSON.stringify(a));
  return a.candidate.commit;
}

const IMPL = { 'src/add.js': 'exports.add = (a, b) => a + b;\n', 'src/check.js': CHECK_JS };
const APP = { 'app/main.js': "const { add } = require('../src/add.js');\nconsole.log(add(2, 3));\n" };

/** The Reviewer step of `task` dispatched: its dispatch id and card. */
async function reviewer(pp: ProcessProject, task: string): Promise<{ dispatch: string; card: any }> {
  const next = await pmNext(pp.ctx);
  const s = next.ready.find((r) => r.kind === 'reviewer' && r.step.includes(`.${task}.`));
  assert.ok(s !== undefined, `no ready reviewer of ${task}: ${next.ready.map((r) => r.step).join(', ')}`);
  const d = pmDispatch(pp.ctx, s.step);
  readAll(pp.ctx, d.dispatch);
  return { dispatch: d.dispatch, card: dispatchView(pp.ctx, d.dispatch).card };
}

// ---------------------------------------------------------------- 1: one hand-back runs each command once

describe('1: one hand-back runs each command once', () => {
  it('a network: true command executes once per hand-back; the flow reads the hand-back\'s runs as its verified event', async () => {
    const c = counting();
    p = processProject({ options: { runner: c.runner } });
    await addMissionToReview(p, M, { detailed: planWithNetwork() });
    assert.equal(c.count(NET), 1, 'the hand-back ran it; the flow did not run it again');
    await pmNext(p.ctx);
    assert.equal(c.count(NET), 1);
    assert.equal(evidenceOf(p.ctx, NET).length, 1, 'one evidence record');
    const v = verifiedEvents(p.ctx, 'impl');
    assert.deepEqual(v.map((x) => x.key), ['1']);
    assert.deepEqual(v[0]!.runs.map((r) => r.evidence).filter((e) => evidenceOf(p!.ctx, NET).includes(e)), evidenceOf(p.ctx, NET));
    const r = await reviewer(p, 'impl');
    assert.deepEqual(r.card.verificationRuns.map((x: { evidence: string }) => x.evidence), v[0]!.runs.map((x) => x.evidence), "the Reviewer's card shows the hand-back's runs");
  });

  it('the flow wrote the event first (another process): the hand-back keeps it and adopts nothing else; no conflict', async () => {
    const c = counting();
    p = processProject({ options: { runner: c.runner } });
    await planned(p, planWithNetwork());
    const pp = p;
    let raced = false;
    let handbackRuns = null as readonly VerificationRun[] | null;
    const ctx = pp.reopen(ENV_A, {
      actions: (cx) => {
        const base = gitActions(cx);
        return {
          ...base,
          async verify(req) {
            const r = await base.verify(req);
            if (!raced) {
              raced = true;
              if (r !== 'pending') handbackRuns = r;
              // another mp process advances the flow before this hand-back records its verified event
              const other = openProcess(pp.dir, { git: PlainGit.create(), observe: () => ENV_A, ident: IDENT, runner: c.runner });
              try {
                await advance(other, M as MissionId);
              } finally {
                other.memory.close();
              }
            }
            return r;
          },
        } satisfies GitActions;
      },
    });
    const s = await readyOf(ctx, 'constructor');
    const d = pmDispatch(ctx, s.step);
    for (const [rel, text] of Object.entries(IMPL)) write(join(pp.dir, d.worktree!), rel, text);
    const a = await handBack(ctx, d.dispatch, { done: 'done', unmet_standards: [], unfixed_problems: [], decisions_needed: [] });
    assert.ok(a.kind === 'recorded' && a.outcome === 'accepted', JSON.stringify(a));
    assert.deepEqual(a.notes.filter((n) => /could not/.test(n)), [], 'the second writer is a no-op, not a conflict');
    assert.ok(raced && handbackRuns !== null);
    const v = verifiedEvents(ctx, 'impl');
    assert.equal(v.length, 1);
    // the race's cost: the network command ran in both processes (never reusable); the flow's record stands
    assert.equal(c.count(NET), 2);
    const flowNet = v[0]!.runs.find((x) => x.command === NET)!.evidence;
    assert.notEqual(flowNet, handbackRuns!.find((x) => x.command === NET)!.evidence);
    const next = await pmNext(ctx);
    assert.deepEqual(next.errors, []);
    assert.ok(!alerts(ctx).includes('flow-internal-error'), JSON.stringify(alerts(ctx)));
    const r = await reviewer(pp, 'impl');
    assert.ok(r.card.verificationRuns.some((x: { evidence: string }) => x.evidence === flowNet));
  });

  it('the hand-back wrote the event while the flow ran (inside the flow\'s write): the flow adopts it; no conflict', async () => {
    const c = counting();
    p = processProject({ options: { runner: c.runner } });
    await planned(p, planWithNetwork());
    const pp = p;
    let calls = 0;
    const ctx = pp.reopen(ENV_A, {
      actions: (cx) => {
        const base = gitActions(cx);
        // the hand-back finds its runs executing in another process ("pending"): it records nothing; the flow runs them
        return { ...base, async verify(req) { return ++calls === 1 ? 'pending' : base.verify(req); } } satisfies GitActions;
      },
    });
    const s = await readyOf(ctx, 'constructor');
    const d = pmDispatch(ctx, s.step);
    for (const [rel, text] of Object.entries(IMPL)) write(join(pp.dir, d.worktree!), rel, text);
    // the hand-back process records its verified event between the flow's read and the flow's write
    const ledger = ctx.ports().ledger;
    const append = ledger.append.bind(ledger);
    let injected = null as readonly VerificationRun[] | null;
    ledger.append = async (op, entries) => {
      if (injected === null && op.startsWith('flow:verified:')) {
        const product = ctx.memory.read((db) => flowEvents(db, { mission: M as MissionId, line: 'task:impl', event: 'product' }))[0]!;
        const snapshot = (JSON.parse(ctx.memory.data.text(product.body)) as { snapshot: string }).snapshot;
        const commands = [{ id: 'check', command: 'node src/check.js' }, { id: 'net', command: NET, network: true }];
        const runs = await gitActions(ctx).verify({ mission: M as MissionId, object: `prod.con.${M}.impl.1`, snapshot, commands });
        assert.notEqual(runs, 'pending');
        injected = runs as VerificationRun[];
        assert.equal(recordVerified(ctx, dispatchView(ctx, d.dispatch), injected), 'recorded');
      }
      return append(op, entries);
    };
    const a = await handBack(ctx, d.dispatch, { done: 'done', unmet_standards: [], unfixed_problems: [], decisions_needed: [] });
    assert.ok(a.kind === 'recorded' && a.outcome === 'accepted', JSON.stringify(a));
    assert.ok(injected !== null, 'the flow reached its write');
    const v = verifiedEvents(ctx, 'impl');
    assert.equal(v.length, 1);
    assert.deepEqual(v[0]!.runs, injected, "the first writer's runs stand");
    const next = await pmNext(ctx);
    assert.deepEqual(next.errors, []);
    assert.ok(!alerts(ctx).includes('flow-internal-error'), JSON.stringify(alerts(ctx)));
    const r = await reviewer(pp, 'impl');
    assert.deepEqual(r.card.verificationRuns.map((x: { evidence: string }) => x.evidence), injected!.map((x) => x.evidence), 'the flow adopted them');
  });
});

// ---------------------------------------------------------------- 3: fullSuite and its alias

describe('3: config fullSuite; closingChecks read as its alias', () => {
  it('a closingChecks-only config is read as the full suite; both keys: fullSuite wins and mp config warns', async () => {
    p = processProject();
    const file = join(p.dir, '.mission-pipeline', 'config.json');
    writeFileSync(file, JSON.stringify({ format: 'mp41.config.v1', targetBranch: 'main', closingChecks: [{ id: 'smoke', command: 'node src/check.js' }] }));
    const shown = await cli(p.dir, ['config', '--json']);
    assert.equal(shown.code, 0, shown.err);
    assert.equal(shown.json.result.fullSuiteReadFrom, 'closingChecks');
    assert.match((await cli(p.dir, ['config'])).out, /Full suite .*read from closingChecks \(deprecated alias/);
    const project = await openProject({ cwd: p.dir, env: { ...process.env, MP_PROJECT: '' }, process: { observe: () => ENV_A, git: PlainGit.create() } }, { flag: null, decides: false });
    try {
      assert.deepEqual(project.ctx.fullSuite, [{ id: 'smoke', command: 'node src/check.js' }], 'the process reads the alias as the full suite');
    } finally {
      project.close();
    }
    writeFileSync(file, JSON.stringify({ format: 'mp41.config.v1', targetBranch: 'main', fullSuite: [{ id: 'all', command: 'npm test', cwd: 'pkg' }], closingChecks: [{ id: 'smoke', command: 'node src/check.js' }] }));
    const both = await cli(p.dir, ['config', '--json']);
    assert.equal(both.json.result.fullSuiteReadFrom, 'fullSuite');
    assert.match((await cli(p.dir, ['config'])).out, /Warning: both fullSuite and the deprecated closingChecks are present/);
    assert.deepEqual(fullSuiteOf({ closingChecks: [{ id: 'a', command: 'x' }] }), [{ id: 'a', command: 'x' }]);
    assert.deepEqual(fullSuiteOf({ fullSuite: [{ id: 'b', command: 'y' }], closingChecks: [{ id: 'a', command: 'x' }] }), [{ id: 'b', command: 'y' }]);
    assert.equal(isFullSuiteCommand([{ id: 'a', command: ['npm', 'test'] }], '  npm   test '), true);
    assert.equal(isFullSuiteCommand([{ id: 'a', command: 'npm test' }], 'npm run lint'), false);
  });
});

// ---------------------------------------------------------------- 4, 5, 6: the integration Reviewer, markers, mp pm full-run

describe('4: the integration Reviewer runs the full suite, last', () => {
  it('non-integration cards offer no full-run; an integration pass without a full run is refused; a full run on an identical tree is reused', async () => {
    const c = counting();
    p = processProject({ files: { 'suite.js': SUITE_JS }, options: { runner: c.runner, fullSuite: SUITE } });
    writeFileSync(join(p.dir, '.mission-pipeline', 'config.json'), JSON.stringify({ format: 'mp41.config.v1', targetBranch: 'main', fullSuite: SUITE }));
    const ctx = p.ctx;
    await planned(p, integrationPlan());
    await construct(p, 'impl', IMPL);
    // the implementation task's Reviewer: no full-run on its card, the command refused
    const ri = await reviewer(p, 'impl');
    assert.doesNotMatch(seatCard(ctx, ri.dispatch).text, /full-run/);
    await assert.rejects(seatFullRun(ctx, ri.dispatch), /has no `full-run` command/);
    const ai = await handBack(ctx, ri.dispatch, reviewerPass(ri.card));
    assert.ok(ai.kind === 'recorded' && ai.outcome === 'accepted', JSON.stringify(ai));
    assert.equal(c.count('node suite.js'), 0, 'nobody ran the full suite for a local task');
    // the integration task
    const candidate = await construct(p, 'integ', APP);
    const rv = await reviewer(p, 'integ');
    const text = seatCard(ctx, rv.dispatch).text;
    assert.match(text, new RegExp(`mp seat ${rv.dispatch} full-run`));
    assert.match(text, /look at the change and the local results above first/);
    assert.match(text, /if something is visibly wrong, hand back "rework" \(or "needs-decision"\) without a full run/);
    // a pass without a full run is refused, with the reason
    const refused = await handBack(ctx, rv.dispatch, reviewerPass(rv.card));
    assert.equal(refused.kind, 'refused');
    assert.match(refused.kind === 'refused' ? refused.problems.join('\n') : '', /cites a passing full run of its candidate/);
    // the full run: by mp, on a clean checkout of the candidate, recorded with its marker
    const fr = await seatFullRun(ctx, rv.dispatch);
    assert.equal(fr.reused, false);
    assert.equal(fr.marker.passed, true);
    assert.equal(fr.marker.commit, candidate);
    assert.equal(fr.marker.tree, treeOf(ctx, candidate));
    assert.equal(fr.marker.cites.dispatch, rv.dispatch);
    assert.equal(c.count('node suite.js'), 1);
    // again on the same tree (the seat's command): reused, nothing runs
    const shown = await cli(p.dir, ['seat', rv.dispatch, 'full-run', '--json']);
    assert.equal(shown.code, 0, shown.err);
    const again = shown.json.result as { reused: boolean; marker: { id: string; reusedFrom: string | null } };
    assert.equal(again.reused, true);
    assert.equal(again.marker.reusedFrom, fr.marker.id);
    assert.equal(c.count('node suite.js'), 1);
    // another commit with the identical tree: reused by tree, not by commit
    const twin = p.git('commit-tree', `${candidate}^{tree}`, '-p', candidate, '-m', 'the same tree again');
    const byTree = await runFullSuite(ctx, { mission: M, commit: twin, suite: SUITE, by: 'pm', cites: { words: null, authority: null, reason: 'twin', dispatch: null } });
    assert.equal(byTree.reused, true);
    assert.equal(byTree.marker.commit, twin);
    assert.equal(c.count('node suite.js'), 1);
    // the pass citing the full run's runs is accepted
    const pass = await handBack(ctx, rv.dispatch, reviewerPass(rv.card, fr.marker.commands.map((x) => `evidence:${x.evidence}`)));
    assert.ok(pass.kind === 'recorded' && pass.outcome === 'accepted', JSON.stringify(pass));
    await pmNext(ctx);
    const product = `prod.con.${M}.integ.1`;
    assert.equal(ctx.memory.read((db) => decisionLabels(db, [product]))[product], 'proven');
    // the markers, newest first
    const markers = ctx.memory.read((db) => fullRunMarkers(db, ctx.memory.data, M));
    assert.deepEqual(markers.map((m) => m.id), [byTree.marker.id, again.marker.id, fr.marker.id]);
    const listed = await cli(p.dir, ['read', 'full-runs', M]);
    assert.equal(listed.code, 0, listed.err);
    assert.match(listed.out, new RegExp(`Full run ${fr.marker.id}: passed`));

    // 6: mp pm full-run at the end of the mission: the PM's decision is recorded
    await assert.rejects(pmFullRun(ctx, { mission: M, reason: 'the changes since' }), /the record must show who decided/);
    await assert.rejects(pmFullRun(ctx, { mission: M, authority: 'g1', reason: 'the changes since' }), /not an authorization item in force/);
    const words = ctx.memory.read((db) => (db.stmt("SELECT words FROM words ORDER BY rev LIMIT 1").get() as { words: string }).words);
    const byWords = await pmFullRun(ctx, { mission: M, words, reason: 'the user wants one more full run before close' });
    assert.equal(byWords.marker.by, 'pm');
    assert.equal(byWords.marker.cites.words, words);
    assert.equal(byWords.marker.cites.reason, 'the user wants one more full run before close');
    assert.deepEqual([...byWords.outputs].sort(), [`prod.con.${M}.impl.1`, product].sort());
    assert.equal(byWords.marker.tree, treeOf(ctx, byWords.candidate));
    const byAuthority = await pmFullRun(ctx, { mission: M, authority: 'a1', reason: 'delegated: details are the PM\'s' });
    assert.equal(byAuthority.marker.cites.authority, `item.${M}.a1`);
    assert.equal(byAuthority.marker.cites.words, null);
    const cliRefused = await cli(p.dir, ['pm', 'full-run', M, '--reason', 'why']);
    assert.notEqual(cliRefused.code, 0);
    assert.match(cliRefused.err + cliRefused.out, /who decided/);
  });
});

describe('4b: an integration rework or needs-decision needs no full run', () => {
  it('needs-decision without a full run is recorded and goes to the Secretary', async () => {
    p = processProject({ files: { 'suite.js': SUITE_JS }, options: { fullSuite: SUITE } });
    const ctx = p.ctx;
    await planned(p, integrationPlan());
    await construct(p, 'impl', IMPL);
    const ri = await reviewer(p, 'impl');
    await handBack(ctx, ri.dispatch, reviewerPass(ri.card));
    await construct(p, 'integ', APP);
    const rv = await reviewer(p, 'integ');
    const unclear = { ...(reviewerPass(rv.card) as Record<string, unknown>), judgments: rv.card.standards.map((s: { id: string }) => ({ standard: s.id, met: 'unclear', reason: 'the standard does not say which output', evidence: rv.card.verificationRuns.map((r: { evidence: string }) => `evidence:${r.evidence}`) })), verdict: 'needs-decision' };
    const a = await handBack(ctx, rv.dispatch, unclear);
    assert.ok(a.kind === 'recorded' && a.outcome === 'accepted', JSON.stringify(a));
    assert.equal(ctx.memory.read((db) => fullRunMarkers(db, ctx.memory.data, M)).length, 0, 'no full run');
    assert.ok((await pmNext(ctx)).ready.some((r) => r.kind === 'secretary'));
  });
});

describe('a stop stops: no full run, rerun or renew in its scope (review r1)', () => {
  it('after mp pm stop, an in-flight integration Reviewer can neither full-run nor rerun, and the PM can neither full-run nor renew; nothing executes', async () => {
    const c = counting();
    p = processProject({ files: { 'suite.js': SUITE_JS }, options: { runner: c.runner, fullSuite: SUITE } });
    const ctx = p.ctx;
    await planned(p, integrationPlan());
    await construct(p, 'impl', IMPL);
    const ri = await reviewer(p, 'impl');
    await handBack(ctx, ri.dispatch, reviewerPass(ri.card));
    await construct(p, 'integ', APP);
    const rv = await reviewer(p, 'integ');
    const before = { suite: c.count('node suite.js'), app: c.count('node app/main.js') };
    pmStop(ctx, { stop: 'stop-1' as never, scope: { kind: 'mission', mission: M as MissionId }, words: 'stop everything on m1', wordsEntry: null });
    await assert.rejects(seatFullRun(ctx, rv.dispatch), (e: { code?: string }) => e.code === 'STOPPED');
    await assert.rejects(seatRerun(ctx, rv.dispatch, 'app'), (e: { code?: string }) => e.code === 'STOPPED');
    const words = ctx.memory.read((db) => (db.stmt('SELECT words FROM words ORDER BY rev LIMIT 1').get() as { words: string }).words);
    await assert.rejects(pmFullRun(ctx, { mission: M, words, reason: 'one more before close' }), (e: { code?: string }) => e.code === 'STOPPED');
    assert.deepEqual({ suite: c.count('node suite.js'), app: c.count('node app/main.js') }, before, 'nothing executed');
    assert.equal(ctx.memory.read((db) => fullRunMarkers(db, ctx.memory.data, M)).length, 0);
    // mp pm renew under the stop: there are runs from an older environment to rerun, and nothing runs
    const moved = p.reopen(ENV_B);
    moved.environment();
    assert.ok(moved.memory.read((db) => renewalCandidates(db)).candidates.length > 0, 'renew has work to do');
    const checks = c.count('node src/check.js');
    await assert.rejects(pmRenew(moved), (e: { code?: string }) => e.code === 'STOPPED');
    assert.equal(c.count('node src/check.js'), checks, 'renew executed nothing');
    assert.deepEqual({ suite: c.count('node suite.js'), app: c.count('node app/main.js') }, before);
  });
});

describe('the full-run reuse key keeps argv boundaries (review r1)', () => {
  it("['node', 'suite.js x'] is another suite than ['node', 'suite.js', 'x']: its full run executes, it does not reuse the other's pass", async () => {
    assert.notEqual(suiteHash([{ id: 's', command: ['n', 'a b'] }]), suiteHash([{ id: 's', command: ['n', 'a', 'b'] }]));
    assert.equal(suiteHash([{ id: 's', command: 'npm  test' }]), suiteHash([{ id: 's', command: 'npm test' }]), 'a command line is still whitespace-normalized');
    const c = counting();
    p = processProject({ files: { 'suite.js': "process.exit(0);\n" }, options: { runner: c.runner } });
    const head = p.git('rev-parse', 'HEAD');
    const cites = { words: 'W-1', authority: null, reason: 'argv', dispatch: null };
    const a = await runFullSuite(p.ctx, { mission: M, commit: head, suite: [{ id: 's', command: ['node', 'suite.js', 'x'] }], by: 'pm', cites });
    assert.equal(a.marker.passed, true);
    const b = await runFullSuite(p.ctx, { mission: M, commit: head, suite: [{ id: 's', command: ['node', 'suite.js x'] }], by: 'pm', cites });
    assert.equal(b.reused, false, 'not the same suite');
    assert.equal(b.marker.passed, false, 'it ran: there is no file "suite.js x"');
  });
});

describe('5: full-run markers and fullRunStatus', () => {
  it('sameTree, and what changed since: the products accepted after the marker and the paths that differ', async () => {
    p = processProject({ files: { 'suite.js': SUITE_JS } });
    const ctx = p.ctx;
    await planned(p, integrationPlan());
    const implCandidate = await construct(p, 'impl', IMPL);
    const ri = await reviewer(p, 'impl');
    await handBack(ctx, ri.dispatch, reviewerPass(ri.card));
    await pmNext(ctx);
    assert.deepEqual(fullRunStatus(ctx, M, treeOf(ctx, implCandidate)), { last: null, sameTree: false, changedSince: null });
    const m1 = await runFullSuite(ctx, { mission: M, commit: implCandidate, suite: SUITE, by: 'pm', cites: { words: 'W-1', authority: null, reason: 'a test', dispatch: null } });
    assert.equal(m1.marker.passed, true);
    const same = fullRunStatus(ctx, M, treeOf(ctx, implCandidate));
    assert.equal(same.last?.id, m1.marker.id);
    assert.equal(same.sameTree, true);
    assert.deepEqual(same.changedSince, { products: [], paths: [] });
    // a later accepted product (no full suite configured: the integration Reviewer is offered no full-run)
    const integCandidate = await construct(p, 'integ', APP);
    const rv = await reviewer(p, 'integ');
    assert.doesNotMatch(seatCard(ctx, rv.dispatch).text, /full-run/, 'no full suite configured: no full-run');
    const a = await handBack(ctx, rv.dispatch, reviewerPass(rv.card));
    assert.ok(a.kind === 'recorded' && a.outcome === 'accepted', JSON.stringify(a));
    await pmNext(ctx);
    const later = fullRunStatus(ctx, M, treeOf(ctx, integCandidate));
    assert.equal(later.last?.id, m1.marker.id);
    assert.equal(later.sameTree, false);
    assert.deepEqual(later.changedSince, { products: [`prod.con.${M}.integ.1`], paths: ['app/main.js'] });
  });
});

// ---------------------------------------------------------------- 7: failing output kept for tracing

describe('7: a failing full run keeps the last 400 lines (at most 64 KiB) of each failing command', () => {
  it('the marker and the run summary keep 400 lines; a local run keeps 40', async () => {
    p = processProject();
    const ctx = p.ctx;
    const head = p.git('rev-parse', 'HEAD');
    const LOUD = `node -e "for (let i = 1; i <= 1000; i++) console.log('L' + i); process.exit(3)"`;
    const r = await runFullSuite(ctx, { mission: M, commit: head, suite: [{ id: 'loud', command: LOUD }], by: 'pm', cites: { words: 'W-1', authority: null, reason: 'trace', dispatch: null } });
    assert.equal(r.marker.passed, false);
    const t = r.marker.failing.find((f) => f.id === 'loud')!.tail.split('\n');
    assert.equal(t.length, 400);
    assert.equal(t[0], 'L601');
    assert.equal(t.at(-1), 'L1000');
    const leaf = readFileSync(join(p.dir, '.mission-pipeline', r.marker.leaf!), 'utf8');
    assert.match(leaf, /\nL601\n/);
    assert.doesNotMatch(leaf, /\nL600\n/);
    const local = await runOnCommit(ctx, { mission: M, commit: head, commands: [{ id: 'loud', command: `${LOUD} # local` }], purpose: 'local', declaration: { by: 'mp', checkout: 'clean', declared: true } });
    assert.equal(local.runs[0]!.tail.split('\n').length, 40);
    // the byte bound: long lines are cut from the start, on a character boundary
    const long = Buffer.from(Array.from({ length: 400 }, (_, i) => `${'é'.repeat(200)}${i}`).join('\n'));
    const cut = tail(long, FULL_RUN_TAIL);
    assert.ok(Buffer.byteLength(cut, 'utf8') <= 64 * 1024);
    assert.ok(cut.endsWith('399'));
    assert.ok(!cut.includes('�'), 'no character split');
    assert.equal(tail(Buffer.from(Array.from({ length: 100 }, (_, i) => `x${i}`).join('\n')), LOCAL_TAIL).split('\n').length, 40);
  });
});

// ---------------------------------------------------------------- 8: an environment change

describe('8: an environment change no longer invalidates proof', () => {
  it('a proven product stays proven, shown as "older environment"; mp pm next lists no renew step, one notice', async () => {
    p = processProject();
    await addMissionToReview(p, M);
    await step(p.ctx, 'reviewer', (card) => reviewerPass(card));
    await pmNext(p.ctx);
    const product = `prod.con.${M}.impl.1`;
    assert.equal(p.ctx.memory.read((db) => decisionLabels(db, [product]))[product], 'proven');
    const ctx = p.reopen(ENV_B);
    const next = await pmNext(ctx);
    assert.equal(ctx.memory.read((db) => decisionLabels(db, [product]))[product], 'proven', 'still proven');
    assert.equal(Object.hasOwn(next, 'renew'), false, 'no renew step');
    assert.ok(!next.ready.some((r) => r.step.includes('renew')));
    assert.ok(next.olderEnvironmentRuns >= 1);
    assert.equal(next.notices.filter((n) => n.category === 'environment-older-runs').length, 1);
    assert.match(next.notices.find((n) => n.category === 'environment-older-runs')!.trigger, /\d+ run\(s\) that current proof rests on/);
    await pmNext(ctx);
    assert.equal(alerts(ctx).filter((x) => x === 'environment-older-runs').length, 1, 'once per environment change');
    // the reads: the label and the run say "older environment"
    const g = buildGraph(ctx);
    assert.equal(g.nodes.get(`object:${product}`)?.state, 'proven (older environment)');
    const run = [...g.nodes.values()].find((n) => n.kind === 'run' && n.id.includes('.check'));
    assert.match(run?.state ?? '', /^passed \(older environment\)$/);
    // a card shows a run from an older environment so
    const ev = run!.id;
    const card = ctx.memory.read((db) => cardForSeat(db, { seat: 'reviewer', verificationRuns: [{ evidence: ev, command: 'node src/check.js', summary: 'completed; exit 0' }] }));
    assert.equal((card['verificationRuns'] as Array<{ summary: string }>)[0]!.summary, 'completed; exit 0 (older environment)');
  });

  it('stable mode does not wait on it: a dependent task is dispatched on a product accepted on runs from an older environment', async () => {
    p = processProject({ files: { 'suite.js': SUITE_JS } });
    await planned(p, integrationPlan());
    await construct(p, 'impl', IMPL);
    // the verification ran here; the folder then opens on another machine before the Reviewer judges
    const ctx = p.reopen(ENV_B);
    const ri = await reviewer(p, 'impl');
    assert.match(seatCard(ctx, ri.dispatch).text, /\(older environment\)/, 'the card shows its runs from an older environment');
    const a = await handBack(ctx, ri.dispatch, reviewerPass(ri.card));
    assert.ok(a.kind === 'recorded' && a.outcome === 'accepted', JSON.stringify(a));
    const next = await pmNext(ctx);
    assert.ok(next.ready.some((r) => r.kind === 'constructor' && r.step.includes('.integ.')), `stable mode dispatches the dependent; ready: ${next.ready.map((r) => r.step).join(', ')}; held: ${next.held.map((h) => h.why).join('; ')}`);
    const product = `prod.con.${M}.impl.1`;
    assert.equal(ctx.memory.read((db) => decisionLabels(db, [product]))[product], 'proven');
  });
});
