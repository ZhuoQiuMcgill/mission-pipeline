// `mp land` end to end through the real adapter (design 6.6 step 7, WI-06): a delivery
// recorded in a real ledger, a real repository with the target branch checked out in its
// main checkout, the landing in the controlled view (bubblewrap), the ledger journal of
// phases, and the result classified. Skipped where bubblewrap cannot run.

import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { canonicalJson } from '../src/common/hash.ts';
import { runCli } from '../src/cli/main.ts';
import { detectExecCapabilities } from '../src/exec/platform.ts';
import { discoverRepo } from '../src/git/objects.ts';
import { readTransformDescription } from '../src/git/representation.ts';
import { SafeGit } from '../src/git/safeGit.ts';
import { ContentStore } from '../src/ledger/content.ts';
import { ledgerPaths } from '../src/ledger/service.ts';
import { cleanupEnvs, LedgerProc } from './scheduler-fixtures.ts';
import { cliEnv, ledgerCall, writeConfig } from './cli-fixtures.ts';

const caps = detectExecCapabilities();
const skip = caps.bwrapUsable ? false : 'needs a usable bubblewrap (the landing\'s controlled view, 6.6)';

const procs: LedgerProc[] = [];
afterEach(async () => {
  for (const p of procs.splice(0)) await p.kill();
  await cleanupEnvs();
});

test('mp land lands a recorded delivery into the main checkout; a second land is classified, never redone blindly', { skip, timeout: 120_000 }, async () => {
  const env = cliEnv('land-real');
  const home = join(env.root, 'home');
  mkdirSync(home);
  const repo = join(env.root, 'repo');
  mkdirSync(repo);
  const gitEnv = { PATH: '/usr/bin:/bin', HOME: home, LANG: 'C.UTF-8', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@example.invalid' };
  const git = (args: string[]): string => execFileSync('/usr/bin/git', args, { cwd: repo, env: gitEnv, encoding: 'utf8' }).trim();
  git(['init', '-q', '-b', 'main']);
  writeFileSync(join(repo, 'a.txt'), 'base\n');
  git(['add', 'a.txt']);
  git(['commit', '-q', '-m', 'base']);
  const base = git(['rev-parse', 'HEAD']);
  // the delivery commit on top of the base, under the program's ref; main and the worktree stay at the base
  const blob = execFileSync('/usr/bin/git', ['hash-object', '-w', '--stdin'], { cwd: repo, env: gitEnv, input: 'delivered\n', encoding: 'utf8' }).trim();
  const tree = execFileSync('/usr/bin/git', ['mktree'], { cwd: repo, env: gitEnv, input: `100644 blob ${blob}\ta.txt\n`, encoding: 'utf8' }).trim();
  const commit = git(['commit-tree', tree, '-p', base, '-m', 'delivery']);
  git(['update-ref', 'refs/mission-pipeline/delivered/m1/op-real', commit]);

  writeConfig(env, { extra: { projects: [{ root: repo, targetBranch: 'main', mainCheckout: repo }] } });
  const lp = new LedgerProc(env);
  await lp.start();
  procs.push(lp);
  // the delivery record, with the manifest naming the transform description its products were verified under
  const sg = SafeGit.create({ stateDir: join(env.root, 'sg') });
  const description = await readTransformDescription(sg, await discoverRepo(sg, repo), { home });
  const content = new ContentStore(ledgerPaths(env.ledgerRoot, env.cp).content);
  const transform = content.put(canonicalJson(description));
  const manifest = content.put(canonicalJson({ manifest: { entries: [{ object: { id: 'p1', tree: { commit, writeScope: ['a.txt'], transform } }, unit: null, label: 'proven', requiredBy: [] }] } }));
  await ledgerCall(env, 'recordDelivery', { op: 'rec-op-real', mission: 'm1', delivery: 'op-real', commit, base, ref: 'refs/mission-pipeline/delivered/m1/op-real', manifest });

  const io = { cwd: repo, env: { ...process.env, MP_CONFIG: env.configPath, HOME: home }, now: Date.now };
  const r = await runCli(['land', 'op-real', '--op', 'land-1'], io);
  assert.equal(r.exitCode, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /Landed: the target branch contains the delivery commit/);
  assert.equal(git(['rev-parse', 'main']), commit);
  assert.equal(readFileSync(join(repo, 'a.txt'), 'utf8'), 'delivered\n', 'the main checkout was updated with the branch');
  const show = await runCli(['show', 'delivery', 'op-real'], io);
  assert.match(show.stdout, /landed \(the target branch contains the delivery commit\)/);
  assert.match(show.stdout, /attempts that reached the push: 1\/4/);
  // a new attempt of a landed delivery: the lease no longer holds; classified, nothing written
  const again = await runCli(['land', 'op-real', '--op', 'land-2', '--json'], io);
  const j = JSON.parse(again.stdout) as { result: { landed: boolean } };
  assert.equal(j.result.landed, true, again.stdout);
});
