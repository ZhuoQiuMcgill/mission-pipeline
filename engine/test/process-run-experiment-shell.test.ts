// The shell of an experiment executor's reruns (config.json `experimentShell`): a registered
// method may be written for bash, while the platform's shell (/bin/sh) can be dash. Only a run
// declared both `experiment` and `rerun` gets the configured shell; every other run keeps the
// platform's shell, and without the key nothing changes.
//   1  which runs get which shell, through runOnCommit
//   2  commandShellFor: the declaration decides
//   3  with /bin/bash: a bash-only construct ($'\t') reads as a tab in the experiment rerun
//   4  config.json: an absolute path, optional

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { afterEach, describe, it } from 'node:test';
import { parseConfig, defaultConfig } from '../src/cli/config.ts';
import type { MissionId } from '../src/common/ids.ts';
import { runOnCommit, shellRunner, type CommandRunner } from '../src/process/index.ts';
import { commandShellFor } from '../src/process/runs.ts';
import { processProject, type ProcessProject } from './process-fixtures.ts';

const M = 'm1' as MissionId;
const DECLARED = { by: 'mp', checkout: 'clean', declared: true } as const;
const FILES = { 'check.js': "console.log('ok 1 - checks');\n" };

let p: ProcessProject | null = null;
afterEach(() => {
  const q = p;
  p = null;
  q?.cleanup();
});

function recording(): { readonly runner: CommandRunner; readonly shells: Array<{ command: string; shell: string | undefined }> } {
  const shells: Array<{ command: string; shell: string | undefined }> = [];
  return {
    shells,
    runner: (req) => {
      shells.push({ command: req.command, shell: req.shell });
      return shellRunner(req);
    },
  };
}

describe('1: only an experiment executor\'s rerun gets the experiment shell', () => {
  it('a verification run, a plain rerun and an experiment mark alone keep the platform shell', async () => {
    const rec = recording();
    p = processProject({ files: FILES, options: { runner: rec.runner, experimentShell: '/bin/sh' } });
    const commit = p.git('rev-parse', 'HEAD');
    const run = (command: string, declaration: Record<string, unknown>) => runOnCommit(p!.ctx, { mission: M, commit, commands: [{ id: 'c', command }], purpose: 'shell test', declaration: { ...DECLARED, ...declaration } });
    await run('node check.js --declared', {});
    await run('node check.js --rerun', { rerun: true });
    await run('node check.js --experiment-mark', { experiment: true });
    await run('node check.js --experiment-rerun', { experiment: true, rerun: true });
    const of = (c: string) => rec.shells.filter((x) => x.command === c).map((x) => x.shell);
    assert.deepEqual(of('node check.js --declared'), [undefined]);
    assert.deepEqual(of('node check.js --rerun'), [undefined]);
    assert.deepEqual(of('node check.js --experiment-mark'), [undefined]);
    assert.deepEqual(of('node check.js --experiment-rerun'), ['/bin/sh']);
  });

  it('without the key, an experiment rerun keeps the platform shell', async () => {
    const rec = recording();
    p = processProject({ files: FILES, options: { runner: rec.runner } });
    const commit = p.git('rev-parse', 'HEAD');
    await runOnCommit(p.ctx, { mission: M, commit, commands: [{ id: 'c', command: 'node check.js' }], purpose: 'shell test', declaration: { ...DECLARED, experiment: true, rerun: true } });
    assert.deepEqual(rec.shells.map((x) => x.shell), [undefined]);
  });
});

describe('2: commandShellFor', () => {
  it('the declaration decides', () => {
    const ctx = { experimentShell: '/bin/bash' };
    assert.equal(commandShellFor(ctx, {}), undefined);
    assert.equal(commandShellFor(ctx, { rerun: true }), undefined);
    assert.equal(commandShellFor(ctx, { experiment: true }), undefined);
    assert.equal(commandShellFor(ctx, { experiment: true, rerun: true }), '/bin/bash');
    assert.equal(commandShellFor({}, { experiment: true, rerun: true }), undefined);
  });
});

describe('3: a bash-only construct in an experiment rerun', { skip: !existsSync('/bin/bash') }, () => {
  it("$'\\t' is a tab under /bin/bash", () => {
    const out = shellRunner({ command: "IFS=$'\\t' read -r a b <<< \"x\ty\"; printf '%s|%s' \"$a\" \"$b\"", cwd: process.cwd(), timeoutMs: 10_000, shell: '/bin/bash' });
    assert.equal(out.exitCode, 0);
    assert.equal(out.output.toString('utf8'), 'x|y');
  });
});

describe('4: config.json', () => {
  it('an optional absolute path', () => {
    const base = defaultConfig({ targetBranch: 'main', versionCommands: [] });
    assert.equal(parseConfig(base).experimentShell, undefined, 'mp init writes none');
    assert.equal(parseConfig({ ...base, experimentShell: '/bin/bash' }).experimentShell, '/bin/bash');
    assert.throws(() => parseConfig({ ...base, experimentShell: 'bash' }));
  });
});
