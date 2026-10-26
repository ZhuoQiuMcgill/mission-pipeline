// The time limits of declared commands (config.json `commandTimeoutMs`, `experimentCommandTimeoutMs`):
// an exploration's experiment may need a day, where a hung test should end within minutes. So the
// reruns of an experiment executor (`mp seat <id> rerun` on a constructor-experiment card) get
// their own limit, and every other run keeps `commandTimeoutMs`.
//   1  which runs get which limit: only a run declared both `experiment` and `rerun` gets the
//      experiment limit; a verification run, any other rerun and an experiment mark alone do not
//   2  without the key, the experiment limit is `commandTimeoutMs` (and 30 minutes without either)
//   3  with the platform's shell: the same slow command times out as a plain rerun and completes as
//      an experiment rerun
//   4  the seats: a constructor-experiment card's rerun gets the experiment limit, a Reviewer's
//      rerun the command limit
//   5  config.json: validated (at most 7 days), threaded into the context, shown by `mp config`

import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { openProject } from '../src/cli/project.ts';
import { defaultConfig, experimentCommandTimeoutOf, MAX_EXPERIMENT_COMMAND_TIMEOUT_MS, parseConfig } from '../src/cli/config.ts';
import type { MissionId } from '../src/common/ids.ts';
import { cal1Pass } from '../src/flow/scripted.ts';
import { PlainGit } from '../src/git/plainGit.ts';
import { pmDispatch, pmMission, pmPlan, pmRequirement, pmSay, runOnCommit, shellRunner, type CommandRunner, type ProcessContext } from '../src/process/index.ts';
import { commandTimeoutFor } from '../src/process/runs.ts';
import { dispatchView, recordEvidenceRequest, seatRerun } from '../src/process/seat.ts';
import { cli } from './cli-fixtures.ts';
import { addDetailedPlan, addMissionToReview, ENV_A, processProject, readAll, readyOf, step, type ProcessProject } from './process-fixtures.ts';

const M = 'm1' as MissionId;
const DECLARED = { by: 'mp', checkout: 'clean', declared: true } as const;
const MINUTE = 60_000;
const FILES = { 'check.js': "console.log('ok 1 - checks');\n", 'probe.js': "console.log('status: ok');\n" };

let p: ProcessProject | null = null;
afterEach(() => {
  const q = p;
  p = null;
  q?.cleanup();
});

/** A runner that records the time limit each command line was given, and runs it with the platform's shell. */
function recording(): { readonly runner: CommandRunner; readonly limits: Array<{ command: string; timeoutMs: number }> } {
  const limits: Array<{ command: string; timeoutMs: number }> = [];
  return {
    limits,
    runner: (req) => {
      limits.push({ command: req.command, timeoutMs: req.timeoutMs });
      return shellRunner(req);
    },
  };
}

const limitsOf = (limits: ReadonlyArray<{ command: string; timeoutMs: number }>, command: string): number[] => limits.filter((x) => x.command === command).map((x) => x.timeoutMs);

describe('1: only an experiment executor\'s rerun gets the experiment limit', () => {
  it('a verification run, a plain rerun and an experiment mark without a rerun keep commandTimeoutMs', async () => {
    const rec = recording();
    p = processProject({ files: FILES, options: { runner: rec.runner, commandTimeoutMs: 5 * MINUTE, experimentCommandTimeoutMs: 36 * 60 * MINUTE } });
    const commit = p.git('rev-parse', 'HEAD');
    const run = (command: string, declaration: Record<string, unknown>) => runOnCommit(p!.ctx, { mission: M, commit, commands: [{ id: 'c', command }], purpose: 'timeout test', declaration: { ...DECLARED, ...declaration } });
    await run('node check.js --declared', {});
    await run('node check.js --rerun', { rerun: true });
    await run('node check.js --experiment-mark', { experiment: true });
    const xp = await run('node check.js --experiment-rerun', { experiment: true, rerun: true });
    assert.equal(xp.runs[0]!.passed, true);
    assert.deepEqual(limitsOf(rec.limits, 'node check.js --declared'), [5 * MINUTE]);
    assert.deepEqual(limitsOf(rec.limits, 'node check.js --rerun'), [5 * MINUTE]);
    assert.deepEqual(limitsOf(rec.limits, 'node check.js --experiment-mark'), [5 * MINUTE]);
    assert.deepEqual(limitsOf(rec.limits, 'node check.js --experiment-rerun'), [36 * 60 * MINUTE]);
  });

  it('commandTimeoutFor: the declaration decides', () => {
    const ctx = { commandTimeoutMs: 1_000, experimentCommandTimeoutMs: 9_000 };
    assert.equal(commandTimeoutFor(ctx, {}), 1_000);
    assert.equal(commandTimeoutFor(ctx, { rerun: true }), 1_000);
    assert.equal(commandTimeoutFor(ctx, { experiment: true }), 1_000);
    assert.equal(commandTimeoutFor(ctx, { experiment: true, rerun: true }), 9_000);
  });
});

describe('2: without the key the experiment limit is the command limit', () => {
  it('commandTimeoutMs alone sets both; neither: 30 minutes', async () => {
    const rec = recording();
    p = processProject({ files: FILES, options: { runner: rec.runner, commandTimeoutMs: 7 * MINUTE } });
    assert.equal(p.ctx.experimentCommandTimeoutMs, 7 * MINUTE);
    await runOnCommit(p.ctx, { mission: M, commit: p.git('rev-parse', 'HEAD'), commands: [{ id: 'c', command: 'node check.js' }], purpose: 'timeout test', declaration: { ...DECLARED, experiment: true, rerun: true } });
    assert.deepEqual(limitsOf(rec.limits, 'node check.js'), [7 * MINUTE]);
    const ctx = p.reopen(ENV_A, { commandTimeoutMs: undefined });
    assert.equal(ctx.commandTimeoutMs, 30 * MINUTE);
    assert.equal(ctx.experimentCommandTimeoutMs, 30 * MINUTE);
  });
});

describe('3: with the platform\'s shell', () => {
  it('a command slower than commandTimeoutMs times out as a plain rerun and completes as an experiment rerun', async () => {
    p = processProject({ files: { ...FILES, 'slow.js': "setTimeout(() => console.log('ok 1 - slow'), 2500);\n" }, options: { commandTimeoutMs: 1_000, experimentCommandTimeoutMs: 60_000 } });
    const commit = p.git('rev-parse', 'HEAD');
    const req = { mission: M, commit, commands: [{ id: 'slow', command: 'node slow.js' }], purpose: 'timeout test' };
    const plain = await runOnCommit(p.ctx, { ...req, declaration: { ...DECLARED, rerun: true } });
    assert.equal(plain.runs[0]!.fields['status'], 'timeout');
    assert.equal(plain.runs[0]!.passed, false);
    const xp = await runOnCommit(p.ctx, { ...req, declaration: { ...DECLARED, rerun: true, experiment: true } });
    assert.equal(xp.runs[0]!.fields['status'], 'completed');
    assert.equal(xp.runs[0]!.passed, true);
    assert.ok(Number(xp.runs[0]!.fields['durationMs']) >= 2_000, 'it ran past commandTimeoutMs');
  });
});

/** A mission whose exploration X1 asks for an experiment (`node probe.js`): the experiment executor's dispatch. */
async function experimentDispatch(ctx: ProcessContext, m: string): Promise<string> {
  pmMission(ctx, m);
  const w = pmSay(ctx, `Find a cache design with no obvious logical hole. The details are yours to decide. (${m})`).words;
  await pmRequirement(ctx, { mission: m, item: 'a1', type: 'authorization', text: "Details are the PM's", quote: 'The details are yours to decide', words: w });
  await pmPlan(ctx, {
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
          exploration: { id: 'X1', deliverable: 'a cache design', fuzzyGoal: { quote: 'no obvious logical hole', words: w }, attackScope: ['internal contradiction'], decision: { id: 'D1', type: 'structure' }, budget: { rounds: 3, micros: null }, stop: '', research: false },
          after: [],
          items: [],
        },
      ],
      goalsBeyond: [],
      authorizations: ['a1'],
    },
  });
  await step(ctx, 'calibrator-1', (c) => cal1Pass(c));
  const s = await readyOf(ctx, 'researcher-author');
  const author = pmDispatch(ctx, s.step);
  readAll(ctx, author.dispatch);
  const a = await recordEvidenceRequest(ctx, author.dispatch, { request: { steps: ['run the probe'], data: 'the repository', measure: ['status'], assertions: ['the probe prints a status'], executor: 'experiment', commands: [{ id: 'probe', command: 'node probe.js' }] }, notes: 'need a run' });
  assert.equal(a.kind, 'recorded', JSON.stringify(a));
  const x = await readyOf(ctx, 'constructor-experiment');
  const d = pmDispatch(ctx, x.step);
  readAll(ctx, d.dispatch);
  return d.dispatch;
}

describe('4: the seats', () => {
  it("a constructor-experiment card's `mp seat <id> rerun` gets experimentCommandTimeoutMs", async () => {
    const rec = recording();
    p = processProject({ files: FILES, options: { runner: rec.runner, commandTimeoutMs: 5 * MINUTE, experimentCommandTimeoutMs: 48 * 60 * MINUTE } });
    const d = await experimentDispatch(p.ctx, 'm1');
    assert.equal(dispatchView(p.ctx, d).card.seat, 'constructor-experiment');
    const r = await seatRerun(p.ctx, d, 'probe');
    assert.equal(r.passed, true);
    assert.deepEqual(limitsOf(rec.limits, 'node probe.js'), [48 * 60 * MINUTE]);
  });

  it("a Reviewer's `mp seat <id> rerun` and the Constructor's verification keep commandTimeoutMs", async () => {
    const rec = recording();
    p = processProject({ options: { runner: rec.runner, commandTimeoutMs: 5 * MINUTE, experimentCommandTimeoutMs: 48 * 60 * MINUTE } });
    await addMissionToReview(p, M, { detailed: addDetailedPlan(M, { verification: [{ id: 'check', command: 'node src/check.js' }] }) });
    assert.deepEqual([...new Set(limitsOf(rec.limits, 'node src/check.js'))], [5 * MINUTE], 'the verification of the candidate');
    const s = await readyOf(p.ctx, 'reviewer');
    const d = pmDispatch(p.ctx, s.step);
    const before = rec.limits.length;
    const r = await seatRerun(p.ctx, d.dispatch, 'check');
    assert.equal(r.passed, true);
    assert.deepEqual(rec.limits.slice(before).map((x) => x.timeoutMs), [5 * MINUTE]);
  });
});

describe('5: config.json experimentCommandTimeoutMs', () => {
  const base = { format: 'mp41.config.v1', targetBranch: 'main' };

  it('optional, whole milliseconds from 1 s to 7 days; absent, the command timeout is in effect', () => {
    assert.equal(MAX_EXPERIMENT_COMMAND_TIMEOUT_MS, 7 * 24 * 60 * MINUTE);
    const absent = parseConfig(base);
    assert.equal(absent.experimentCommandTimeoutMs, undefined);
    assert.equal(experimentCommandTimeoutOf(absent), 30 * MINUTE);
    assert.equal(experimentCommandTimeoutOf(parseConfig({ ...base, commandTimeoutMs: 3_600_000 })), 3_600_000);
    const week = parseConfig({ ...base, commandTimeoutMs: 3_600_000, experimentCommandTimeoutMs: MAX_EXPERIMENT_COMMAND_TIMEOUT_MS });
    assert.equal(experimentCommandTimeoutOf(week), MAX_EXPERIMENT_COMMAND_TIMEOUT_MS);
    assert.equal(week.commandTimeoutMs, 3_600_000, 'the command timeout is unchanged');
    assert.equal(defaultConfig({ targetBranch: 'main', versionCommands: [] }).experimentCommandTimeoutMs, undefined, 'mp init writes none');
    for (const bad of [MAX_EXPERIMENT_COMMAND_TIMEOUT_MS + 1, 999, 1_500.5, '36h', null]) {
      assert.throws(() => parseConfig({ ...base, experimentCommandTimeoutMs: bad }), (e: { code?: string; message?: string }) => e.code === 'BAD_CONFIG' && /experimentCommandTimeoutMs/.test(e.message ?? ''), JSON.stringify(bad));
    }
    // commandTimeoutMs keeps its own cap of 24 hours
    assert.throws(() => parseConfig({ ...base, commandTimeoutMs: 24 * 60 * MINUTE + 1 }), (e: { code?: string }) => e.code === 'BAD_CONFIG');
  });

  it('reaches the context from config.json; mp config shows it', async () => {
    p = processProject();
    const file = join(p.dir, '.mission-pipeline', 'config.json');
    const open = async (): Promise<{ command: number; experiment: number }> => {
      const project = await openProject({ cwd: p!.dir, env: { ...process.env, MP_PROJECT: '' }, process: { observe: () => ENV_A, git: PlainGit.create() } }, { flag: null, decides: false });
      try {
        return { command: project.ctx.commandTimeoutMs, experiment: project.ctx.experimentCommandTimeoutMs };
      } finally {
        project.close();
      }
    };
    writeFileSync(file, JSON.stringify({ ...base, commandTimeoutMs: 3_600_000, experimentCommandTimeoutMs: 172_800_000 }));
    assert.deepEqual(await open(), { command: 3_600_000, experiment: 172_800_000 });
    const shown = await cli(p.dir, ['config']);
    assert.equal(shown.code, 0, shown.err);
    assert.match(shown.out, /Command timeout: 3600 s\nExperiment command timeout \(an exploration's experiment reruns\): 172800 s$/m);
    const json = (await cli(p.dir, ['config', '--json'])).json.result;
    assert.equal(json.experimentCommandTimeoutMs, 172_800_000);
    assert.equal(json.experimentCommandTimeoutMsInEffect, 172_800_000);
    // without the key: the command timeout, and mp config says so
    writeFileSync(file, JSON.stringify({ ...base, commandTimeoutMs: 3_600_000 }));
    assert.deepEqual(await open(), { command: 3_600_000, experiment: 3_600_000 });
    assert.match((await cli(p.dir, ['config'])).out, /Experiment command timeout \(an exploration's experiment reruns\): 3600 s \(experimentCommandTimeoutMs not set: the command timeout\)/);
    // over 7 days: refused, with the key named
    writeFileSync(file, JSON.stringify({ ...base, experimentCommandTimeoutMs: MAX_EXPERIMENT_COMMAND_TIMEOUT_MS + 1 }));
    const bad = await cli(p.dir, ['config', '--json']);
    assert.equal(bad.code, 3);
    assert.equal(bad.json.error.code, 'BAD_CONFIG');
    assert.match(bad.json.error.message, /experimentCommandTimeoutMs/);
  });
});
