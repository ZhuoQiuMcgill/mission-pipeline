import type { GitOid } from '../src/common/ids.ts';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { commitTree, discoverRepo, treeOfCommit } from '../src/git/objects.ts';
import {
  GitExitError,
  GitOutputLimitError,
  GitTimeoutError,
  identifyProcess,
  isProcessAlive,
  SafeGit,
} from '../src/git/safeGit.ts';
import { initRepo, makeFixture, rawCommit, withProcessEnv, writeExecutable, type Fixture } from './git-fixtures.test.ts';

let fx: Fixture;
let repo: string;
let A: GitOid;

before(() => {
  fx = makeFixture('safegit');
  repo = initRepo(fx);
  A = rawCommit(fx, repo, { 'f.txt': 'one\n' }, null, 'A');
  fx.raw(['update-ref', 'refs/heads/main', A], repo);
});
after(() => fx.cleanup());

test('the environment starts empty: injected GIT_CONFIG_* and the caller HOME never reach git', async () => {
  const otherHome = join(fx.root, 'other-home');
  mkdirSync(otherHome);
  writeFileSync(join(otherHome, '.gitconfig'), '[user]\n\tname = FromGlobal\n');
  // Control: raw git with that environment does see both.
  const control = fx.raw(['config', '--get', 'user.name'], repo, {
    env: { HOME: otherHome, GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'user.name', GIT_CONFIG_VALUE_0: 'Injected' },
  });
  assert.equal(control, 'Injected');
  await withProcessEnv(
    { HOME: otherHome, GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'user.name', GIT_CONFIG_VALUE_0: 'Injected', GIT_DIR: '/nonexistent' },
    async () => {
      const r = await fx.git.run(['config', '--get', 'user.name'], { cwd: repo });
      assert.equal(r.code, 1, 'no user.name visible: neither injected nor global');
      const env = fx.git.buildEnv();
      assert.deepEqual(Object.keys(env).sort(), [
        'GIT_ATTR_NOSYSTEM',
        'GIT_CONFIG_GLOBAL',
        'GIT_CONFIG_NOSYSTEM',
        'GIT_GRAFT_FILE',
        'GIT_NO_LAZY_FETCH',
        'GIT_NO_REPLACE_OBJECTS',
        'GIT_TERMINAL_PROMPT',
        'HOME',
        'LANG',
        'PATH',
      ]);
      assert.equal(env.HOME, fx.git.emptyHome);
    },
  );
});

test('hooks point at an empty read-only directory, and repository hooks and fsmonitor never run', async () => {
  const mark = join(fx.root, 'hook-mark');
  const hooks = join(repo, '.git', 'hooks');
  mkdirSync(hooks, { recursive: true });
  writeExecutable(join(hooks, 'post-index-change'), `#!/bin/sh\necho hook >> '${mark}'\n`);
  writeExecutable(join(fx.root, 'fsmonitor.sh'), `#!/bin/sh\necho fsmonitor >> '${mark}'\nexit 1\n`);
  fx.raw(['config', 'core.fsmonitor', join(fx.root, 'fsmonitor.sh')], repo);
  fx.raw(['config', 'core.hooksPath', hooks], repo);
  try {
    // Control: raw git runs the index hook when it writes a temporary index.
    fx.raw(['read-tree', A], repo, { env: { GIT_INDEX_FILE: join(fx.root, 'ctl-index') } });
    assert.match(readFileSync(mark, 'utf8'), /hook/);
    writeFileSync(mark, '');

    const hp = await fx.git.text(['config', '--get', 'core.hooksPath'], { cwd: repo });
    assert.equal(hp, fx.git.noHooksDir);
    assert.equal(statSync(fx.git.noHooksDir).mode & 0o777, 0o555);
    assert.deepEqual(readdirSync(fx.git.noHooksDir), []);
    await fx.git.ok(['read-tree', A], { cwd: repo, env: { GIT_INDEX_FILE: join(fx.root, 'safe-index') } });
    await fx.git.ok(['status', '--porcelain'], { cwd: repo });
    assert.equal(readFileSync(mark, 'utf8'), '', 'neither the index hook nor fsmonitor ran');
  } finally {
    fx.raw(['config', '--unset', 'core.fsmonitor'], repo);
    fx.raw(['config', '--unset', 'core.hooksPath'], repo);
  }
});

test('commit signing configured in the repository is never run', async () => {
  const mark = join(fx.root, 'gpg-mark');
  writeExecutable(join(fx.root, 'fake-gpg.sh'), `#!/bin/sh\necho gpg >> '${mark}'\nexit 1\n`);
  fx.raw(['config', 'commit.gpgSign', 'true'], repo);
  fx.raw(['config', 'gpg.program', join(fx.root, 'fake-gpg.sh')], repo);
  try {
    // Control: a raw porcelain commit honours commit.gpgSign and runs the program.
    fx.raw(['update-ref', 'refs/heads/main', A], repo);
    const ctl = fx.rawStatus(['-c', 'core.hooksPath=/dev/null', 'commit', '--allow-empty', '-m', 'x'], repo);
    assert.notEqual(ctl.code, 0);
    assert.match(readFileSync(mark, 'utf8'), /gpg/);
    writeFileSync(mark, '');
    // The engine's commit-tree runs with commit.gpgSign=false and --no-gpg-sign.
    const layout = await discoverRepo(fx.git, repo);
    const c = await commitTree(fx.git, layout, await treeOfCommit(fx.git, layout, A), [A], 'signed?\n', { name: 'a', email: 'a@b' }, { name: 'a', email: 'a@b' });
    assert.match(c, /^[0-9a-f]{40}$/);
    assert.equal(readFileSync(mark, 'utf8'), '');
  } finally {
    fx.raw(['config', '--unset', 'commit.gpgSign'], repo);
    fx.raw(['config', '--unset', 'gpg.program'], repo);
  }
});

test('variables and -c keys outside the allow-lists are refused', async () => {
  await assert.rejects(() => fx.git.run(['status'], { cwd: repo, env: { GIT_DIR: '/x' } }), /not allowed: GIT_DIR/);
  await assert.rejects(() => fx.git.run(['status'], { cwd: repo, config: [['core.pager', 'evil']] }), /config key not allowed/);
  await assert.rejects(() => fx.git.run(['status'], { cwd: repo, config: [['filter.x.smudge', 'evil']] }), /config key not allowed/);
});

test('user scope only allows read-only configuration queries', async () => {
  const scope = { kind: 'user', environment: fx.user } as const;
  await assert.rejects(() => fx.git.run(['status'], { cwd: repo, scope }), /read-only/);
  await assert.rejects(() => fx.git.run(['config', 'user.name', 'x'], { cwd: repo, scope }), /--get/);
  const r = await fx.git.run(['config', '--get', 'core.bare'], { cwd: repo, scope });
  assert.equal(r.stdout.toString().trim(), 'false');
});

test('typed results: exit code and stderr are captured; ok() throws GitExitError', async () => {
  const r = await fx.git.run(['rev-parse', '--verify', 'no-such-ref'], { cwd: repo });
  assert.equal(r.code, 128);
  assert.match(r.stderr.toString(), /Needed a single revision/);
  assert.equal(r.process.bootId, identifyProcess(process.pid).bootId);
  await assert.rejects(() => fx.git.ok(['rev-parse', '--verify', 'no-such-ref'], { cwd: repo }), GitExitError);
  const ok = await fx.git.ok(['rev-parse', '--verify', 'no-such-ref'], { cwd: repo, okCodes: [128] });
  assert.equal(ok.code, 128);
});

test('a timeout kills the whole process group and reports the process identity', async () => {
  const pidFile = join(fx.root, 'child.pid');
  const fake = join(fx.root, 'slow-git.sh');
  writeExecutable(fake, `#!/bin/sh\nsleep 30 &\necho $! > '${pidFile}'\nsleep 30\n`);
  const slow = SafeGit.create({ stateDir: join(fx.root, 'state-slow'), gitPath: fake });
  let seen: number | null = null;
  const err = await slow.run(['anything'], { cwd: fx.root, timeoutMs: 300, onSpawn: (p) => (seen = p.pid) }).then(
    () => null,
    (e: unknown) => e,
  );
  assert.ok(err instanceof GitTimeoutError, String(err));
  assert.equal(err.exitedInGrace, true);
  assert.equal(err.process?.pid, seen);
  await err.exited;
  const childPid = Number(readFileSync(pidFile, 'utf8').trim());
  const deadline = Date.now() + 3000;
  while (isProcessAlive(identifyProcess(childPid)) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
  assert.equal(isProcessAlive(identifyProcess(childPid)), false, 'the background child died with the group');
});

test('output beyond the limit is refused', async () => {
  const fake = join(fx.root, 'loud-git.sh');
  writeExecutable(fake, '#!/bin/sh\nhead -c 200000 /dev/zero\n');
  const loud = SafeGit.create({ stateDir: join(fx.root, 'state-loud'), gitPath: fake });
  await assert.rejects(() => loud.run(['x'], { cwd: fx.root, maxOutputBytes: 1000 }), GitOutputLimitError);
});

test('process identity: alive while running, not alive after a reboot or pid reuse', () => {
  const me = identifyProcess(process.pid);
  assert.equal(isProcessAlive(me), true);
  assert.equal(isProcessAlive({ ...me, bootId: 'another-boot' }), false);
  assert.equal(isProcessAlive({ ...me, startTicks: '1' }), false);
  assert.equal(existsSync('/proc/sys/kernel/random/boot_id'), true);
});

test('a sandbox-bound wrapper sends every run through the sandbox and refuses user-scope reads', async () => {
  const seen: string[][] = [];
  const sandbox = {
    gitEnvironment: () => ({ PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', HOME: fx.git.emptyHome }),
    wrap: (argv: readonly string[], env: Readonly<Record<string, string>>, cwd: string) => {
      seen.push([...argv]);
      return { file: argv[0] as string, args: argv.slice(1), env, cwd };
    },
  };
  const bound = fx.git.withSandbox(sandbox);
  const r = await bound.ok(['rev-parse', 'HEAD'], { cwd: repo });
  assert.equal(r.stdout.toString().trim(), A);
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0]?.slice(-2), ['rev-parse', 'HEAD']);
  await assert.rejects(() => bound.run(['config', '--get', 'core.bare'], { cwd: repo, scope: { kind: 'user', environment: fx.user } }), /repository scope only/);
});
