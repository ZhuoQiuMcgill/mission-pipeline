// The project's cleanup of a run's checkout (config.json `cleanupCommands`): commands `mp` runs in
// a run's checkout root after the run's commands and before it removes the checkout, so that what
// the commands made outside the checkout (a container network, a built image) is released too.
//   1  each executed run runs them once, in the checkout root (whatever the commands' cwd), after
//      its commands; a reused run executes nothing and runs none; a full run runs them too
//   2  they still run when a command fails, and when the runner throws (the error still surfaces)
//   3  a failing or throwing cleanup command changes no result, evidence or reuse; it is a note in
//      the run summary leaf, and the later cleanup commands still run
//   4  without the key nothing extra runs and the leaf has no cleanup part
//   5  config.json: the key is validated, threaded into the context, and shown by `mp config`

import assert from 'node:assert/strict';
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { openProject } from '../src/cli/project.ts';
import { defaultConfig, parseConfig } from '../src/cli/config.ts';
import type { MissionId } from '../src/common/ids.ts';
import { PlainGit } from '../src/git/plainGit.ts';
import { pmMission, runFullSuite, runOnCommit, shellRunner, type CommandRunner, type ProcessContext } from '../src/process/index.ts';
import { cli } from './cli-fixtures.ts';
import { ENV_A, processProject, type ProcessProject } from './process-fixtures.ts';

const M = 'm1' as MissionId;
const DECLARED = { by: 'mp', checkout: 'clean', declared: true } as const;
const FILES = {
  'check.js': "console.log('ok 1 - checks');\n",
  'fail.js': "console.log('not ok 1 - checks');\nprocess.exit(1);\n",
  'broken.js': "console.log('cleanup could not reach the daemon');\nprocess.exit(3);\n",
  'src/index.js': '\n',
};

let p: ProcessProject | null = null;
afterEach(() => {
  const q = p;
  p = null;
  q?.cleanup();
});

/** A command that appends "<label> <its cwd>" to a log file outside the project (the project's base folder). */
function logger(q: ProcessProject): { readonly cmd: (label: string) => string; lines(): string[] } {
  const base = dirname(q.dir);
  const script = join(base, 'log.js');
  const log = join(base, 'log.txt');
  writeFileSync(script, "require('node:fs').appendFileSync(process.argv[2], process.argv[3] + ' ' + process.cwd() + '\\n');\n");
  return {
    cmd: (label) => `node ${JSON.stringify(script)} ${JSON.stringify(log)} ${label}`,
    lines: () => (existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter((x) => x !== '') : []),
  };
}

/** The checkout folder of `run`, as its commands see it. */
const checkoutOf = (ctx: ProcessContext, run: string): string => join(realpathSync(ctx.memory.paths.tmp), run);

/** A run's summary leaf, as recorded. */
function leafText(ctx: ProcessContext, leaf: string | null): string {
  const text = leaf === null ? null : (ctx.memory.readLeaf(leaf)?.text ?? null);
  assert.ok(text !== null, `the run summary leaf ${leaf} is there`);
  return text;
}

const evidenceCount = (ctx: ProcessContext): number => ctx.memory.read((db) => Number((db.stmt("SELECT COUNT(*) AS n FROM log WHERE kind = 'evidence'").get() as { n: number }).n));

/** A runner that records every command line and throws for the ones in `throwing`. */
function recording(throwing: readonly string[] = []): { readonly runner: CommandRunner; readonly calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    runner: (req) => {
      calls.push(req.command);
      if (throwing.includes(req.command)) throw new Error(`the runner broke on ${req.command}`);
      return shellRunner(req);
    },
  };
}

describe('1: the cleanup commands run once per executed run, in the checkout root, after its commands', () => {
  it('in the root although a command ran in src/; a reused run runs nothing; a rerun runs them again in its own checkout', async () => {
    p = processProject({ files: FILES });
    const log = logger(p);
    p.reopen(ENV_A, { cleanupCommands: [{ id: 'release', command: log.cmd('cleanup') }] });
    const commit = p.git('rev-parse', 'HEAD');
    const req = { mission: M, commit, commands: [{ id: 'root', command: log.cmd('root') }, { id: 'sub', command: log.cmd('sub'), cwd: 'src' }], purpose: 'cleanup test', declaration: DECLARED };
    const r = await runOnCommit(p.ctx, req);
    assert.equal(r.reused, false);
    assert.ok(r.runs.every((x) => x.passed));
    const dir = checkoutOf(p.ctx, r.run);
    assert.deepEqual(log.lines(), [`root ${dir}`, `sub ${join(dir, 'src')}`, `cleanup ${dir}`]);
    assert.equal(existsSync(dir), false, 'the checkout is removed after the cleanup');
    assert.doesNotMatch(leafText(p.ctx, r.leaf), /## Cleanup/, 'a cleanup that passed leaves no note');
    // the same declared run again: reused, nothing executes, no cleanup
    const again = await runOnCommit(p.ctx, req);
    assert.equal(again.reused, true);
    assert.equal(log.lines().length, 3);
    // a rerun (a sampling run) executes: one more cleanup, in its own checkout
    const rerun = await runOnCommit(p.ctx, { ...req, commands: [req.commands[0]!], declaration: { ...DECLARED, rerun: true } });
    assert.equal(rerun.reused, false);
    assert.notEqual(rerun.run, r.run);
    assert.deepEqual(log.lines().slice(3), [`root ${checkoutOf(p.ctx, rerun.run)}`, `cleanup ${checkoutOf(p.ctx, rerun.run)}`]);
  });

  it('a full run runs them too, after its suite', async () => {
    p = processProject({ files: FILES });
    const log = logger(p);
    p.reopen(ENV_A, { cleanupCommands: [{ id: 'release', command: log.cmd('cleanup') }] });
    pmMission(p.ctx, M);
    const fr = await runFullSuite(p.ctx, { mission: M, commit: p.git('rev-parse', 'HEAD'), suite: [{ id: 'suite', command: log.cmd('suite') }], by: 'pm', cites: { words: null, authority: null, reason: 'cleanup test', dispatch: null } });
    assert.equal(fr.marker.passed, true);
    const dir = checkoutOf(p.ctx, fr.marker.id);
    assert.deepEqual(log.lines(), [`suite ${dir}`, `cleanup ${dir}`]);
  });
});

describe('2: they still run when a command fails', () => {
  it('a failing command: the run is recorded as failed, later commands and then the cleanup still run', async () => {
    p = processProject({ files: FILES });
    const log = logger(p);
    p.reopen(ENV_A, { cleanupCommands: [{ id: 'release', command: log.cmd('cleanup') }] });
    const r = await runOnCommit(p.ctx, { mission: M, commit: p.git('rev-parse', 'HEAD'), commands: [{ id: 'fail', command: 'node fail.js' }, { id: 'after', command: log.cmd('after') }], purpose: 'cleanup test', declaration: DECLARED });
    assert.deepEqual(r.runs.map((x) => x.passed), [false, true]);
    const dir = checkoutOf(p.ctx, r.run);
    assert.deepEqual(log.lines(), [`after ${dir}`, `cleanup ${dir}`]);
  });

  it('a runner that throws: the cleanup runs, the checkout goes, the error surfaces and nothing is recorded', async () => {
    p = processProject({ files: FILES });
    const log = logger(p);
    const rec = recording(['boom']);
    p.reopen(ENV_A, { runner: rec.runner, cleanupCommands: [{ id: 'release', command: log.cmd('cleanup') }] });
    const before = evidenceCount(p.ctx);
    await assert.rejects(runOnCommit(p.ctx, { mission: M, commit: p.git('rev-parse', 'HEAD'), commands: [{ id: 'boom', command: 'boom' }], purpose: 'cleanup test', declaration: DECLARED }), /the runner broke on boom/);
    assert.deepEqual(rec.calls, ['boom', log.cmd('cleanup')]);
    assert.equal(log.lines().length, 1);
    const dir = log.lines()[0]!.slice('cleanup '.length);
    assert.equal(dirname(dir), realpathSync(p.ctx.memory.paths.tmp), 'in a run checkout under tmp/');
    assert.equal(existsSync(dir), false);
    assert.equal(evidenceCount(p.ctx), before);
  });
});

describe('3: a failing cleanup is best effort', () => {
  it('changes no result, evidence or reuse; it is a note in the summary leaf; the later cleanup commands still run', async () => {
    p = processProject({ files: FILES });
    const log = logger(p);
    const rec = recording(['throwing-cleanup']);
    p.reopen(ENV_A, { runner: rec.runner, cleanupCommands: [{ id: 'broken', command: 'node broken.js' }, { id: 'throws', command: 'throwing-cleanup' }, { id: 'release', command: log.cmd('cleanup') }] });
    const req = { mission: M, commit: p.git('rev-parse', 'HEAD'), commands: [{ id: 'check', command: 'node check.js' }], purpose: 'cleanup test', declaration: DECLARED };
    const before = evidenceCount(p.ctx);
    const r = await runOnCommit(p.ctx, req);
    assert.equal(r.runs[0]!.passed, true);
    assert.equal(evidenceCount(p.ctx), before + 1, 'one evidence record, for the command; none for the cleanup');
    assert.deepEqual(log.lines(), [`cleanup ${checkoutOf(p.ctx, r.run)}`], 'the cleanup after the failing ones still ran');
    const leaf = leafText(p.ctx, r.leaf);
    assert.match(leaf, /## Cleanup/);
    assert.match(leaf, /cleanup command broken \(`node broken\.js`\) failed \(exit 3\); the results above are unchanged/);
    assert.match(leaf, /cleanup could not reach the daemon/, 'its last lines are kept with the note');
    assert.match(leaf, /cleanup command throws \(`throwing-cleanup`\) failed \(the runner broke on throwing-cleanup\)/);
    assert.doesNotMatch(leaf, /cleanup command release/);
    assert.match(leaf, /- Result: passed/);
    // reuse is unchanged: the same request is reused, and nothing runs (no cleanup either)
    const calls = rec.calls.length;
    const again = await runOnCommit(p.ctx, req);
    assert.equal(again.reused, true);
    assert.equal(again.runs[0]!.evidence, r.runs[0]!.evidence);
    assert.equal(rec.calls.length, calls);
    // the evidence equals a fresh execution without any cleanup, but for its run id and duration
    const first = r.runs[0]!;
    const plain = await runOnCommit(p.reopen(ENV_A, { cleanupCommands: [] }), { ...req, doNotReuse: [first.evidence] });
    assert.equal(plain.reused, false);
    const strip = (f: Readonly<Record<string, string>>): Record<string, string> => Object.fromEntries(Object.entries(f).filter(([k]) => k !== 'run' && k !== 'durationMs'));
    assert.deepEqual(strip(first.fields), strip(plain.runs[0]!.fields));
    assert.ok(!Object.keys(first.fields).some((k) => /cleanup/i.test(k)));
  });
});

describe('4: without the key nothing extra runs', () => {
  it('the runner sees exactly the run\'s commands; the leaf has no cleanup part; the config reads none', async () => {
    const rec = recording();
    p = processProject({ files: FILES, options: { runner: rec.runner } });
    assert.deepEqual(p.ctx.cleanupCommands, []);
    const r = await runOnCommit(p.ctx, { mission: M, commit: p.git('rev-parse', 'HEAD'), commands: [{ id: 'check', command: 'node check.js' }, { id: 'fail', command: 'node fail.js' }], purpose: 'cleanup test', declaration: DECLARED });
    assert.deepEqual(rec.calls, ['node check.js', 'node fail.js']);
    assert.doesNotMatch(leafText(p.ctx, r.leaf), /Cleanup|cleanup command/);
    // a config.json without the key
    writeFileSync(join(p.dir, '.mission-pipeline', 'config.json'), JSON.stringify({ format: 'mp41.config.v1', targetBranch: 'main' }));
    const project = await openProject({ cwd: p.dir, env: { ...process.env, MP_PROJECT: '' }, process: { observe: () => ENV_A, git: PlainGit.create() } }, { flag: null, decides: false });
    try {
      assert.deepEqual(project.config.cleanupCommands, []);
      assert.deepEqual(project.ctx.cleanupCommands, []);
    } finally {
      project.close();
    }
    assert.match((await cli(p.dir, ['config'])).out, /Run cleanup: cleanupCommands .*: none/);
  });
});

describe('5: config.json cleanupCommands', () => {
  const base = { format: 'mp41.config.v1', targetBranch: 'main' };
  const DOWN = 'docker compose -f docker-compose.yml --project-directory . down --rmi local --remove-orphans';

  it('accepts { id, command } with a command line or an argv; refuses any other shape', () => {
    const ok = parseConfig({ ...base, cleanupCommands: [{ id: 'compose-down', command: DOWN }, { id: 'argv', command: ['docker', 'compose', 'down'] }] });
    assert.deepEqual(ok.cleanupCommands, [{ id: 'compose-down', command: DOWN }, { id: 'argv', command: ['docker', 'compose', 'down'] }]);
    assert.deepEqual(parseConfig(base).cleanupCommands, [], 'absent: none');
    assert.deepEqual(defaultConfig({ targetBranch: 'main', versionCommands: [] }).cleanupCommands, [], 'mp init writes none');
    for (const bad of [DOWN, [{ id: 'down' }], [{ command: DOWN }], [{ id: 'bad id!', command: DOWN }], [{ id: 'down', command: '' }], [{ id: 'down', command: DOWN, cwd: 'backend' }], [{ id: 'down', command: DOWN, timeoutMs: 1000 }]]) {
      assert.throws(() => parseConfig({ ...base, cleanupCommands: bad }), (e: { code?: string; message?: string }) => e.code === 'BAD_CONFIG' && /cleanupCommands/.test(e.message ?? ''), JSON.stringify(bad));
    }
  });

  it('reaches the context from config.json; mp config shows it', async () => {
    p = processProject();
    writeFileSync(join(p.dir, '.mission-pipeline', 'config.json'), JSON.stringify({ ...base, cleanupCommands: [{ id: 'compose-down', command: DOWN }] }));
    const project = await openProject({ cwd: p.dir, env: { ...process.env, MP_PROJECT: '' }, process: { observe: () => ENV_A, git: PlainGit.create() } }, { flag: null, decides: false });
    try {
      assert.deepEqual(project.ctx.cleanupCommands, [{ id: 'compose-down', command: DOWN }]);
    } finally {
      project.close();
    }
    const shown = await cli(p.dir, ['config']);
    assert.equal(shown.code, 0, shown.err);
    assert.match(shown.out, /Run cleanup: cleanupCommands \(in each run's checkout, after its commands, before mp removes it\):\n {2}compose-down: docker compose .* down --rmi local --remove-orphans/);
    assert.deepEqual((await cli(p.dir, ['config', '--json'])).json.result.cleanupCommands, [{ id: 'compose-down', command: DOWN }]);
  });
});
