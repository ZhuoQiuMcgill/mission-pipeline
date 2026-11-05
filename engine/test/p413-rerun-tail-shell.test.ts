// 4.1.3 (P4 items 2 and 3): a passing rerun's output is kept and returned (#37); the project chooses
// the shell (#27).
//   1  a rerun keeps its last lines, passing or failing, within RERUN_TAIL (400 lines, 64 KiB): in its
//      result, in the run summary leaf and in its "run" event; `mp seat <id> rerun` prints them
//   2  a passing verification run keeps no tail (the common path is unchanged)
//   3  a "run" event the field's code wrote (no tail, no time) folds as before
//   4  config.json `shell`: every declared command (and the cleanup) runs with it; experimentShell
//      still wins for experiment reruns; neither: the platform's shell; `mp config` shows the shell
//      in effect per run class
//   5  the shell is part of the environment identity when set, and only then; a change labels the
//      runs "older environment" (they still count)

import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { openProject } from '../src/cli/project.ts';
import { defaultConfig, parseConfig, shellsInEffect } from '../src/cli/config.ts';
import type { ContentHash, MissionId } from '../src/common/ids.ts';
import { validateRecord } from '../src/common/validate.ts';
import { environmentIdentity, observeEnvironment, olderEnvironmentRun, readEnvironmentConfig, recordedEnvironment } from '../src/evaluator/index.ts';
import { runCounts } from '../src/evaluator/runs.ts';
import { PlainGit } from '../src/git/plainGit.ts';
import { appendRecords, factById } from '../src/memory/index.ts';
import { DISPATCH_LINE, dispatchStepRuns, RERUN_TAIL, runOnCommit, shellRunner, type CommandRunner } from '../src/process/index.ts';
import { dispatchView, seatRerun } from '../src/process/seat.ts';
import { cli } from './cli-fixtures.ts';
import { ENV_A, processProject, type ProcessProject } from './process-fixtures.ts';
import { experimentDispatch } from './p413-fixtures.ts';

const M = 'm1' as MissionId;
const DECLARED = { by: 'mp', checkout: 'clean', declared: true } as const;
const LOUD = "for (let i = 1; i <= 500; i++) console.log('status: item ' + i + ' ok');\n";

let p: ProcessProject | null = null;
afterEach(() => {
  const q = p;
  p = null;
  q?.cleanup();
});

describe('1: a rerun keeps its last lines, passing or failing', () => {
  it('in its result, its summary leaf and its run event; mp seat <id> rerun prints them', async () => {
    p = processProject({ files: { 'loud.js': LOUD } });
    const d = await experimentDispatch(p.ctx, 'm1', 'node loud.js');
    const r = await seatRerun(p.ctx, d, 'probe');
    assert.equal(r.passed, true);
    const lines = r.tail.split('\n');
    assert.equal(lines.length, RERUN_TAIL.lines);
    assert.equal(lines[0], 'status: item 101 ok');
    assert.equal(lines.at(-1), 'status: item 500 ok');
    const leaf = readFileSync(join(p.dir, '.mission-pipeline', r.leaf!), 'utf8');
    assert.match(leaf, /its last lines are below; the whole output is not kept/);
    assert.match(leaf, /\nstatus: item 500 ok\n/);
    assert.doesNotMatch(leaf, /\nstatus: item 100 ok\n/);
    // the dispatch line's run event names the kept tail: a later read returns the recorded lines
    const recorded = p.ctx.memory.read((db) => dispatchStepRuns(db, p!.ctx.memory.data, dispatchView(p!.ctx, d).info));
    assert.equal(recorded.length, 1);
    assert.equal(recorded[0]!.tail, r.tail);
    assert.equal(recorded[0]!.state, 'finished');
    assert.equal(recorded[0]!.passed, true);
    const shown = await cli(p.dir, ['seat', d, 'rerun', 'probe']);
    assert.equal(shown.code, 0, shown.err);
    assert.match(shown.out, /Run \S+: passed — completed; exit 0/);
    assert.match(shown.out, /Last lines of its output:\n(.|\n)*status: item 500 ok\n\(end of the output\)/);
  });

  it('a failing rerun keeps its 400 lines too', async () => {
    p = processProject({ files: { 'loud.js': `${LOUD}process.exitCode = 2;\n` } });
    const d = await experimentDispatch(p.ctx, 'm1', 'node loud.js');
    const r = await seatRerun(p.ctx, d, 'probe');
    assert.equal(r.passed, false);
    assert.equal(r.tail.split('\n').length, RERUN_TAIL.lines);
  });
});

describe('2: a passing verification run keeps no tail', () => {
  it('runOnCommit without keepPassingTail: no tail in the result or the leaf', async () => {
    p = processProject({ files: { 'loud.js': LOUD } });
    const r = await runOnCommit(p.ctx, { mission: M, commit: p.git('rev-parse', 'HEAD'), commands: [{ id: 'loud', command: 'node loud.js' }], purpose: 'verification', declaration: DECLARED });
    assert.equal(r.runs[0]!.passed, true);
    assert.equal(r.runs[0]!.tail, '');
    const leaf = readFileSync(join(p.dir, '.mission-pipeline', r.leaf!), 'utf8');
    assert.match(leaf, /\(the whole output is not kept\)/);
    assert.doesNotMatch(leaf, /Last lines of the output/);
  });
});

describe('3: a run event written by the field\'s code folds as before', () => {
  it('a body without tail, time or detached: finished, no tail; the hand-back still cites it', async () => {
    p = processProject({ files: { 'loud.js': LOUD } });
    const d = await experimentDispatch(p.ctx, 'm1', 'node loud.js');
    const info = dispatchView(p.ctx, d).info;
    // the field's seatRerun wrote { run, command, completed, exit, envLine, envSnapshot } only
    const r = await runOnCommit(p.ctx, { mission: info.mission, commit: p.git('rev-parse', 'HEAD'), commands: [{ id: 'probe', command: 'node loud.js' }], purpose: `rerun of probe by dispatch ${d}`, declaration: { ...DECLARED, rerun: true, experiment: true }, fields: { dispatch: d } });
    const x = r.runs[0]!;
    p.ctx.memory.write({ op: 'field-run-event', payload: {} }, (tx) => {
      appendRecords(tx, [{ kind: 'flow.event', mission: info.mission, line: DISPATCH_LINE(d), event: 'run', key: x.evidence, body: tx.data.put(JSON.stringify({ run: x.evidence, command: 'probe', completed: true, exit: '0', envLine: 'env', envSnapshot: 'x' })) as ContentHash }]);
    });
    const runs = p.ctx.memory.read((db) => dispatchStepRuns(db, p!.ctx.memory.data, info));
    assert.equal(runs.length, 1);
    assert.equal(runs[0]!.state, 'finished');
    assert.equal(runs[0]!.tail, '');
    assert.equal(runs[0]!.at, null);
    assert.equal(runs[0]!.passed, true);
    assert.match(runs[0]!.summary!, /^completed; exit 0/);
  });
});

/** A runner that records the shell each command line was given. */
function recording(): { readonly runner: CommandRunner; readonly shells: Array<{ command: string; shell: string | undefined }> } {
  const shells: Array<{ command: string; shell: string | undefined }> = [];
  return { shells, runner: (req) => (shells.push({ command: req.command, shell: req.shell }), shellRunner(req)) };
}

describe('4: config.json shell', () => {
  it('every declared command and the cleanup run with it; experimentShell wins for experiment reruns', async () => {
    const rec = recording();
    p = processProject({ files: { 'ok.js': "console.log('ok');\n" }, options: { runner: rec.runner, shell: '/bin/sh', experimentShell: '/bin/bash', cleanupCommands: [{ id: 'tidy', command: 'node -e "0" tidy' }] } });
    const commit = p.git('rev-parse', 'HEAD');
    const run = (command: string, declaration: Record<string, unknown>) => runOnCommit(p!.ctx, { mission: M, commit, commands: [{ id: 'c', command }], purpose: 'shell test', declaration: { ...DECLARED, ...declaration } });
    await run('node ok.js --declared', {});
    await run('node ok.js --rerun', { rerun: true });
    await run('node ok.js --experiment-rerun', { experiment: true, rerun: true });
    const of = (c: string) => rec.shells.filter((x) => x.command === c).map((x) => x.shell);
    assert.deepEqual(of('node ok.js --declared'), ['/bin/sh']);
    assert.deepEqual(of('node ok.js --rerun'), ['/bin/sh']);
    assert.deepEqual(of('node ok.js --experiment-rerun'), ['/bin/bash']);
    assert.deepEqual([...new Set(of('node -e "0" tidy'))], ['/bin/sh'], 'a cleanup command is a declared command too');
    // shell alone: the experiment rerun takes it; neither: the platform's shell (as before)
    const only = recording();
    let ctx = p.reopen(ENV_A, { runner: only.runner, shell: '/bin/sh', experimentShell: undefined, cleanupCommands: [] });
    await runOnCommit(ctx, { mission: M, commit, commands: [{ id: 'c', command: 'node ok.js' }], purpose: 'shell test', declaration: { ...DECLARED, experiment: true, rerun: true } });
    assert.deepEqual(only.shells.map((x) => x.shell), ['/bin/sh']);
    const none = recording();
    ctx = p.reopen(ENV_A, { runner: none.runner, shell: undefined, experimentShell: undefined, cleanupCommands: [] });
    await runOnCommit(ctx, { mission: M, commit, commands: [{ id: 'c', command: 'node ok.js' }], purpose: 'shell test', declaration: DECLARED });
    assert.deepEqual(none.shells.map((x) => x.shell), [undefined]);
  });

  it('an optional absolute path; mp config shows the shell in effect per run class; openProject threads it', async () => {
    const base = defaultConfig({ targetBranch: 'main', versionCommands: [] });
    assert.equal(parseConfig(base).shell, undefined, 'mp init writes none');
    assert.equal(parseConfig({ ...base, shell: '/bin/bash' }).shell, '/bin/bash');
    assert.throws(() => parseConfig({ ...base, shell: 'bash' }), /shell/);
    assert.deepEqual(shellsInEffect({ shell: '/bin/bash' }), { declared: '/bin/bash', declaredFrom: 'shell', experimentReruns: '/bin/bash', experimentFrom: 'shell' });
    assert.deepEqual(shellsInEffect({ shell: '/bin/bash', experimentShell: '/bin/zsh' }).experimentReruns, '/bin/zsh');
    p = processProject();
    const file = join(p.dir, '.mission-pipeline', 'config.json');
    writeFileSync(file, JSON.stringify({ format: 'mp41.config.v1', targetBranch: 'main', shell: '/bin/sh' }));
    const shown = await cli(p.dir, ['config']);
    assert.equal(shown.code, 0, shown.err);
    assert.match(shown.out, /Shell of declared commands \(local tests, reruns, renewals, full runs, cleanup\): \/bin\/sh \(shell; part of the environment identity\)/);
    assert.match(shown.out, /Shell of an exploration's experiment reruns: \/bin\/sh \(experimentShell not set: shell\)/);
    assert.deepEqual((await cli(p.dir, ['config', '--json'])).json.result.shellInEffect, { declared: '/bin/sh', experimentReruns: '/bin/sh' });
    const project = await openProject({ cwd: p.dir, env: { ...process.env, MP_PROJECT: '' }, process: { observe: () => ENV_A, git: PlainGit.create() } }, { flag: null, decides: false });
    try {
      assert.equal(project.ctx.shell, '/bin/sh');
    } finally {
      project.close();
    }
    writeFileSync(file, JSON.stringify({ format: 'mp41.config.v1', targetBranch: 'main' }));
    assert.match((await cli(p.dir, ['config'])).out, /Shell of declared commands \(local tests, reruns, renewals, full runs, cleanup\): \/bin\/sh \(the platform's shell; shell not set\)/);
  });
});

describe('5: the shell is part of the environment identity when set', () => {
  it('observed with the shell only when config.json sets one; a change records another identity and labels the older runs', async () => {
    p = processProject();
    const file = join(p.dir, '.mission-pipeline', 'config.json');
    writeFileSync(file, JSON.stringify({ format: 'mp41.config.v1', targetBranch: 'main' }));
    const without = observeEnvironment(p.dir, readEnvironmentConfig(p.dir));
    assert.equal(Object.hasOwn(without, 'shell'), false, 'no shell: the parts (and the identity) are what they were');
    writeFileSync(file, JSON.stringify({ format: 'mp41.config.v1', targetBranch: 'main', shell: '/bin/bash' }));
    const withShell = observeEnvironment(p.dir, readEnvironmentConfig(p.dir));
    assert.equal(withShell.shell, '/bin/bash');
    assert.notEqual(environmentIdentity(withShell), environmentIdentity(without));
    validateRecord({ kind: 'env.snapshot', line: 'env', snapshot: environmentIdentity(withShell), parts: withShell });
    // through the process: a run under the identity without the shell, then the shell set
    writeFileSync(file, JSON.stringify({ format: 'mp41.config.v1', targetBranch: 'main' }));
    let ctx = p.reopen(ENV_A, { observe: undefined });
    const before = ctx.environment().identity;
    const r = await runOnCommit(ctx, { mission: M, commit: p.git('rev-parse', 'HEAD'), commands: [{ id: 'c', command: 'git --version' }], purpose: 'identity', declaration: DECLARED });
    writeFileSync(file, JSON.stringify({ format: 'mp41.config.v1', targetBranch: 'main', shell: '/bin/sh' }));
    ctx = p.reopen(ENV_A, { observe: undefined, shell: '/bin/sh' });
    const after = ctx.environment();
    assert.notEqual(after.identity, before);
    assert.equal(after.changed, true);
    const rec = ctx.memory.read((db) => factById(db, 'evidence', r.runs[0]!.evidence)?.record) as { envLine: string; envSnapshot: string; fields: Record<string, string> };
    const current = ctx.memory.read((db) => recordedEnvironment(db))!.identity;
    assert.equal(olderEnvironmentRun(rec, current), true, 'shown as "older environment"');
    assert.equal(runCounts(rec, undefined), true, 'it still counts (4.1.2)');
  });
});
