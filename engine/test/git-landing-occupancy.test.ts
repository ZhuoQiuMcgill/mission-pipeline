// 6.6 v41, 3.11: occupancy of the target branch (WI-01, WI-02), the PM's explicit
// landing target (WI-01 option 2), the automatic re-check that lands once the
// condition holds, and the external-worktree listing behind WI-02 and WI-03.

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { id, type GitOid, type MissionId, type OpId } from '../src/common/ids.ts';
import { inferOrigin, listExternalWorktrees, overlappingPaths, parseLsFilesDebug } from '../src/git/externalWorktrees.ts';
import { decideOccupancy, land, MemoryLandingJournal, type LandingDeps, type LandingReport, type LandingRequest } from '../src/git/landing.ts';
import { landWhenReady, nextLandingStep } from '../src/git/landingRetry.ts';
import { detachDuplicateCheckout } from '../src/git/pmActions.ts';
import { discoverRepo } from '../src/git/objects.ts';
import { createProgramRef, deliveryRef } from '../src/git/refs.ts';
import { readTransformDescription } from '../src/git/representation.ts';
import { readOccupancy } from '../src/git/worktreeRecord.ts';
import { initRepo, makeFixture, rawCommit, readTreeContent, sameTreeContent, type Fixture } from './git-fixtures.test.ts';

let fx: Fixture;
before(() => {
  fx = makeFixture('landing-occ');
});
after(() => fx.cleanup());

const M = id<MissionId>('m1');
const NO_LEDGER = { reserve: { recoveryReserveBytes: 0, evaluatorPoolBytes: 0 }, sharesVolume: () => false };
let n = 0;

function raw(args: readonly string[], cwd: string): string {
  return fx.raw(['-c', 'core.hooksPath=/dev/null', ...args], cwd);
}

interface World {
  repo: string;
  common: string;
  C0: GitOid;
  A: GitOid;
  B: GitOid;
  req: LandingRequest;
}

/** main: C0 -> C1 -> C2 -> A; the delivery B on A; the repository (bare or not) with main at A. */
async function world(bare = false): Promise<World> {
  const repo = bare ? join(fx.root, `bare${n++}.git`) : initRepo(fx, `occ${n++}`);
  if (bare) fx.raw(['init', '-q', '--bare', '-b', 'main', repo], fx.root);
  const C0 = rawCommit(fx, repo, { 'f.txt': 'zero\n', 'g.txt': 'g\n' }, null, 'C0');
  const C1 = rawCommit(fx, repo, { 'f.txt': 'one-a\n', 'g.txt': 'g\n' }, C0, 'C1');
  const C2 = rawCommit(fx, repo, { 'f.txt': 'one-b\n', 'g.txt': 'g\n' }, C1, 'C2');
  const A = rawCommit(fx, repo, { 'f.txt': 'one\n', 'g.txt': 'g\n' }, C2, 'A');
  const B = rawCommit(fx, repo, { 'f.txt': 'two\n', 'g.txt': 'g\n' }, A, 'B');
  fx.raw(['update-ref', 'refs/heads/main', A], repo);
  fx.raw(['branch', 'feature', A], repo);
  if (!bare) raw(['reset', '-q', '--hard', A], repo);
  const layout = await discoverRepo(fx.git, repo);
  const d = await readTransformDescription(fx.git, layout, fx.user);
  const op = id<OpId>(`op${n++}`);
  assert.equal((await createProgramRef(fx.git, layout, deliveryRef(M, op), B)).kind, 'created');
  return {
    repo,
    common: layout.commonDir,
    C0,
    A,
    B,
    req: { key: { mission: M, op }, repoPath: repo, targetBranch: 'main', base: A, delivery: B, description: d, user: fx.user, ledger: NO_LEDGER },
  };
}

function deps(journal = new MemoryLandingJournal(), extra: Partial<LandingDeps> = {}): LandingDeps {
  return { git: fx.git, journal, scratchDir: fx.root, ...extra };
}

function sha(p: string): string {
  return createHash('sha256').update(readFileSync(p)).digest('hex');
}

/** The bisect state, file by file (BISECT_*, refs/bisect/*). */
function bisectState(common: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of readdirSync(common)) if (name.startsWith('BISECT_')) out[name] = readFileSync(join(common, name), 'utf8');
  const refs = join(common, 'refs', 'bisect');
  if (existsSync(refs)) for (const name of readdirSync(refs)) out[`refs/bisect/${name}`] = readFileSync(join(refs, name), 'utf8');
  return out;
}

test('WI-01: a paused, clean bisect started on main: no landing; the branch, HEAD, index, files and the bisect state are all unchanged', async () => {
  const w = await world();
  raw(['bisect', 'start'], w.repo);
  raw(['bisect', 'bad', 'main'], w.repo);
  raw(['bisect', 'good', w.C0], w.repo);
  assert.equal(spawnSync('git', ['symbolic-ref', '-q', 'HEAD'], { cwd: w.repo, env: fx.env }).status, 1, 'HEAD is detached by the bisect');
  const before = { head: readFileSync(join(w.common, 'HEAD'), 'utf8'), index: sha(join(w.common, 'index')), files: readTreeContent(w.repo), bisect: bisectState(w.common) };
  assert.equal(before.bisect.BISECT_START, 'main\n');
  const journal = new MemoryLandingJournal();
  const rep = await land(w.req, deps(journal));
  assert.equal(rep.kind === 'not-auto-landed' && `${rep.reason}/${rep.wi}`, 'target-busy/WI-01', JSON.stringify(rep));
  assert.match(rep.kind === 'not-auto-landed' ? rep.detail : '', /bisecting from refs\/heads\/main/);
  assert.equal(fx.raw(['rev-parse', 'refs/heads/main'], w.repo), w.A);
  assert.equal(readFileSync(join(w.common, 'HEAD'), 'utf8'), before.head);
  assert.equal(sha(join(w.common, 'index')), before.index);
  assert.deepEqual(sameTreeContent(before.files, readTreeContent(w.repo)), []);
  assert.deepEqual(bisectState(w.common), before.bisect);
  assert.deepEqual(journal.notices.map((x) => [x.wi, x.category]), [['WI-01', 'landing-occupancy']]);
  assert.deepEqual(nextLandingStep(rep), { step: 'wait', reason: 'target-busy' }, 'the default is to wait and land once the bisect is over');
});

test('occupancy as git sees it: HEAD, a paused rebase (merge or apply backend, not am), a bisect from a branch or a detached HEAD', () => {
  const dir = join(fx.root, `occ-files-${n++}`);
  const fresh = (): string => {
    const d = join(dir, String(n++));
    mkdirSync(d, { recursive: true });
    return d;
  };
  assert.deepEqual(readOccupancy(fresh(), 'refs/heads/main'), { branch: 'refs/heads/main', rebasing: null, bisecting: null, inProgress: false });
  let d = fresh();
  mkdirSync(join(d, 'rebase-merge'));
  writeFileSync(join(d, 'rebase-merge', 'head-name'), 'refs/heads/main\n');
  assert.deepEqual(readOccupancy(d, null), { branch: null, rebasing: 'refs/heads/main', bisecting: null, inProgress: true });
  d = fresh();
  mkdirSync(join(d, 'rebase-apply'));
  writeFileSync(join(d, 'rebase-apply', 'head-name'), 'refs/heads/topic\n');
  assert.equal(readOccupancy(d, null).rebasing, 'refs/heads/topic');
  writeFileSync(join(d, 'rebase-apply', 'applying'), '');
  assert.deepEqual(readOccupancy(d, 'refs/heads/topic'), { branch: 'refs/heads/topic', rebasing: null, bisecting: null, inProgress: true }, '`git am` holds no branch');
  d = fresh();
  writeFileSync(join(d, 'BISECT_START'), 'main\n');
  assert.equal(readOccupancy(d, null).bisecting, 'refs/heads/main');
  writeFileSync(join(d, 'BISECT_START'), `${'a'.repeat(40)}\n`);
  assert.deepEqual(readOccupancy(d, null), { branch: null, rebasing: null, bisecting: null, inProgress: true }, 'a bisect from a detached HEAD holds no branch');
  // The decision (v42): zero lands ref-only; one lands if it is the main checkout (or allowed, WI-02 option 2);
  // many and in-operation are WI-01. There is no "designate one of many".
  const occ = (branch: string | null, extra: Partial<ReturnType<typeof readOccupancy>> = {}) => ({ branch, rebasing: null, bisecting: null, inProgress: false, ...extra });
  const main = { root: '/r', gitDir: '/r/.git', occupancy: occ('refs/heads/feature') };
  const wt = (root: string, o: ReturnType<typeof occ>) => ({ root, gitDir: `/r/.git/worktrees/${root.slice(1)}`, occupancy: o });
  const reason = (d: ReturnType<typeof decideOccupancy>): string => (d.ok ? `ok:${d.class}:${d.holder}` : `${d.class}:${d.reason}`);
  assert.equal(reason(decideOccupancy([main], 'refs/heads/main', '/r')), 'ok:zero:null', 'nobody holds it: only the ref moves');
  assert.equal(reason(decideOccupancy([{ ...main, occupancy: occ('refs/heads/main') }], 'refs/heads/main', '/r')), 'ok:one:/r/.git');
  const ext = [main, wt('/x', occ('refs/heads/main'))];
  assert.equal(reason(decideOccupancy(ext, 'refs/heads/main', '/r')), 'one:target-in-external-worktree', 'held only by an external worktree: WI-02');
  assert.equal(reason(decideOccupancy(ext, 'refs/heads/main', '/r', '/x')), 'ok:one:/r/.git/worktrees/x', 'WI-02 option 2: the PM allowed it for this landing');
  assert.equal(reason(decideOccupancy(ext, 'refs/heads/main', '/x')), 'ok:one:/r/.git/worktrees/x', 'it is the registered main checkout');
  const two = [main, wt('/x', occ('refs/heads/main')), wt('/y', occ('refs/heads/main'))];
  assert.equal(reason(decideOccupancy(two, 'refs/heads/main', '/x')), 'many:target-in-several-worktrees');
  assert.equal(reason(decideOccupancy(two, 'refs/heads/main', '/x', '/y')), 'many:target-in-several-worktrees', 'an allowance never picks one of many');
  const rebasing = [main, wt('/x', occ(null, { rebasing: 'refs/heads/main', inProgress: true }))];
  assert.equal(reason(decideOccupancy(rebasing, 'refs/heads/main', '/x', '/x')), 'in-operation:target-busy', 'never past a rebase in progress');
  const bareZero = [{ root: null, gitDir: '/b.git', occupancy: occ(null) }, wt('/x', occ('refs/heads/feature'))];
  assert.equal(reason(decideOccupancy(bareZero, 'refs/heads/main', null)), 'ok:zero:null', 'a bare common repository without a checkout of main');
});

test('WI-01 option 2 (v43): the PM detaches the abandoned duplicate checkout (nothing removed, nothing deleted); the re-check finds one occupant and lands by itself', async () => {
  const w = await world(true);
  const L1 = join(fx.root, `L1-${n++}`);
  const L2 = join(fx.root, `L2-${n++}`);
  raw(['worktree', 'add', '-q', L1, 'main'], w.repo);
  raw(['worktree', 'add', '-q', '-f', L2, 'main'], w.repo); // an agent's duplicate, now abandoned
  // Its leftovers: an uncommitted change, an untracked and an ignored file.
  writeFileSync(join(L2, 'g.txt'), 'g edited\n');
  writeFileSync(join(L2, 'untracked.txt'), 'u\n');
  const l2Admin = raw(['rev-parse', '--absolute-git-dir'], L2);
  mkdirSync(join(w.common, 'info'), { recursive: true });
  writeFileSync(join(w.common, 'info', 'exclude'), 'ignored.bin\n');
  writeFileSync(join(L2, 'ignored.bin'), 'i\n');
  const l2Before = { files: readTreeContent(L2), index: sha(join(l2Admin, 'index')) };
  const req = { ...w.req, mainCheckout: L1 };
  const journals: MemoryLandingJournal[] = [];
  const pm: { detached: Awaited<ReturnType<typeof detachDuplicateCheckout>> | null } = { detached: null };
  const result = await landWhenReady(
    w.common,
    async () => {
      const j = new MemoryLandingJournal();
      journals.push(j);
      return land(req, deps(j));
    },
    {
      recheckMs: 120_000,
      minAttemptIntervalMs: 0,
      onWaiting: async () => {
        if (pm.detached !== null) return;
        // Not for the only occupant, and not for a worktree that does not hold the branch.
        assert.equal((await detachDuplicateCheckout(fx.git, { repoPath: w.repo, worktree: L2, targetBranch: 'feature' })).kind, 'refused');
        // The PM's option through the CLI: detach the duplicate (the safe wrapper, hooks off).
        pm.detached = await detachDuplicateCheckout(fx.git, { repoPath: w.repo, worktree: L2, targetBranch: 'main' });
      },
    },
  );
  const detached = pm.detached;
  assert.equal(detached?.kind, 'detached', JSON.stringify(detached));
  assert.equal(result.ended, 'landed', JSON.stringify(result.report));
  assert.equal(result.attempts, 2);
  assert.deepEqual(journals[0]?.notices.map((x) => x.wi), ['WI-01']);
  assert.equal(readFileSync(join(L1, 'f.txt'), 'utf8'), 'two\n');
  assert.equal(raw(['status', '--porcelain'], L1), '');
  // The duplicate: HEAD detached at the same commit, its index byte for byte and every file (changed, untracked, ignored) as before.
  assert.equal(spawnSync('git', ['-C', L2, 'symbolic-ref', '-q', 'HEAD'], { env: fx.env }).status, 1, 'detached');
  assert.equal(raw(['rev-parse', 'HEAD'], L2), w.A);
  assert.equal(sha(join(l2Admin, 'index')), l2Before.index);
  assert.deepEqual(sameTreeContent(l2Before.files, readTreeContent(L2)), []);
  assert.match(detached?.kind === 'detached' ? detached.undo : '', /switch main$/);
});

test('v42 zero occupancy: nobody holds main (a bare common repository): a ref-only controlled landing; every worktree unchanged', async () => {
  const w = await world(true);
  const F = join(fx.root, `F-${n++}`);
  raw(['worktree', 'add', '-q', F, 'feature'], w.repo);
  const before = { index: sha(join(w.common, 'worktrees', F.split('/').pop() as string, 'index')), files: readTreeContent(F) };
  const journal = new MemoryLandingJournal();
  const rep = await land({ ...w.req, mainCheckout: null }, deps(journal));
  assert.equal(rep.kind, 'checked', JSON.stringify(rep));
  if (rep.kind !== 'checked') return;
  assert.equal(rep.outcome, 'landed');
  assert.equal(rep.verification.landed, true);
  assert.equal(fx.raw(['rev-parse', 'refs/heads/main'], w.repo), w.B);
  // Admission counted only the repository directory.
  assert.deepEqual(rep.admission?.filesystems.flatMap((f) => f.destinations), ['repository']);
  // Every registered worktree: HEAD, index and files unchanged.
  assert.deepEqual(rep.verification.worktrees.map((v) => v.kind), ['expected', 'expected']);
  assert.equal(sha(join(w.common, 'worktrees', F.split('/').pop() as string, 'index')), before.index);
  assert.deepEqual(sameTreeContent(before.files, readTreeContent(F)), []);
  assert.deepEqual(journal.notices, []);
});

test('the default of WI-01: refused while two checkouts hold main, then landed by itself as soon as one switches away (a change, not the 10-minute interval)', async () => {
  const w = await world();
  const L = join(fx.root, `L-${n++}`);
  raw(['worktree', 'add', '-q', '-f', L, 'main'], w.repo);
  const reports: LandingReport[] = [];
  const started = Date.now();
  let switched = false;
  const result = await landWhenReady(
    w.common,
    async () => {
      const r = await land(w.req, deps());
      reports.push(r);
      return r;
    },
    {
      recheckMs: 120_000,
      minAttemptIntervalMs: 0,
      onWaiting: () => {
        if (switched) return;
        switched = true;
        setTimeout(() => raw(['switch', '-q', 'feature'], L), 300);
      },
    },
  );
  assert.equal(result.ended, 'landed');
  assert.equal(result.attempts, 2);
  assert.equal(reports[0]?.kind === 'not-auto-landed' && reports[0].reason, 'target-in-several-worktrees');
  assert.equal(result.report.kind === 'checked' && result.report.verification.landed, true, JSON.stringify(result.report));
  assert.ok(Date.now() - started < 60_000, 'woken by the change, not by the interval');
  assert.equal(readFileSync(join(w.repo, 'f.txt'), 'utf8'), 'two\n');
  // Aborting the wait ends it without another attempt.
  const w2 = await world();
  raw(['worktree', 'add', '-q', '-f', join(fx.root, `L-${n++}`), 'main'], w2.repo);
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 200);
  const aborted = await landWhenReady(w2.common, () => land(w2.req, deps()), { recheckMs: 120_000, signal: ac.signal });
  assert.deepEqual([aborted.ended, aborted.attempts], ['aborted', 1]);
});

test('external worktrees (6.6 v41): branch, HEAD, occupancy, lock, inferred origin, live processes, last change, and the paths changed against the base', async () => {
  const w = await world();
  const claude = join(w.repo, '.claude', 'worktrees', 'agent-1');
  const codex = join(fx.root, `codex-${n++}`);
  const plain = join(fx.root, `plain-${n++}`);
  raw(['worktree', 'add', '-q', '-b', 'agent', claude, w.A], w.repo);
  raw(['worktree', 'add', '-q', '-b', 'codex/fix', codex, w.A], w.repo);
  raw(['worktree', 'add', '-q', '--detach', plain, w.A], w.repo);
  raw(['worktree', 'lock', '--reason', 'on a removable disk', plain], w.repo);
  // The agent committed one change, staged another and left a third unstaged.
  mkdirSync(join(claude, 'src'));
  writeFileSync(join(claude, 'src', 'a.ts'), 'a\n');
  raw(['add', 'src/a.ts'], claude);
  fx.raw(['-c', 'core.hooksPath=/dev/null', 'commit', '-q', '-m', 'agent work'], claude);
  writeFileSync(join(claude, 'g.txt'), 'g staged\n');
  raw(['add', 'g.txt'], claude);
  writeFileSync(join(claude, 'f.txt'), 'f unstaged edit, longer\n');
  // A process working inside the Codex worktree.
  const sleeper = spawn('sleep', ['30'], { cwd: codex, stdio: 'ignore' });
  try {
    await new Promise((r) => setTimeout(r, 100));
    const list = await listExternalWorktrees(fx.git, w.common, { base: w.A, mainCheckout: w.repo });
    const by = (p: string) => list.find((x) => x.path === p);
    assert.equal(list.length, 4);
    assert.equal(by(w.repo)?.isMainCheckout, true);
    assert.equal(by(w.repo)?.occupancy.branch, 'refs/heads/main');
    const c = by(claude);
    assert.equal(c?.origin, 'claude');
    assert.equal(c?.branch, 'refs/heads/agent');
    assert.deepEqual(c?.changed, { committed: ['src/a.ts'], uncommitted: ['f.txt', 'g.txt'] });
    assert.ok((c?.lastModified ?? 0) > Date.now() - 60_000);
    const x = by(codex);
    assert.equal(x?.origin, 'codex');
    assert.deepEqual(x?.liveProcesses, [sleeper.pid]);
    assert.deepEqual(x?.changed, { committed: [], uncommitted: [] });
    const p = by(plain);
    assert.equal(p?.locked, 'on a removable disk');
    assert.equal(p?.branch, null);
    assert.equal(p?.origin, 'unknown');
    // WI-03: overlap with a mission's write scope.
    assert.deepEqual(overlappingPaths([...(c?.changed?.committed ?? []), ...(c?.changed?.uncommitted ?? [])], ['src/**', 'docs/**']), ['src/a.ts']);
  } finally {
    sleeper.kill('SIGKILL');
  }
  assert.equal(inferOrigin('/home/u/p/.claude/worktrees/x', null), 'claude');
  assert.equal(inferOrigin('/tmp/w', 'refs/heads/codex/task'), 'codex');
  assert.equal(inferOrigin('/tmp/w', 'refs/heads/feature'), 'unknown');
  assert.deepEqual(
    parseLsFilesDebug(Buffer.from('a b\0  ctime: 1:2\n  mtime: 3:4\n  dev: 5\tino: 6\n  uid: 7\tgid: 8\n  size: 9\tflags: 0\nc\0  ctime: 1:2\n  mtime: 10:11\n  dev: 5\tino: 12\n  uid: 7\tgid: 8\n  size: 13\tflags: 0\n')).map((e) => [e.path, e.mtimeSec, e.ino, e.size]),
    [
      ['a b', 3n, 6n, 9n],
      ['c', 10n, 12n, 13n],
    ],
  );
});

test('6.5 v43-v47 class B: a dirty main checkout refuses every time; new attempts after changes; the 5th push-stage attempt is refused (WI-08)', async () => {
  const w = await world();
  writeFileSync(join(w.repo, 'f.txt'), 'local edit\n'); // the user's work in progress, never committed
  // One delivery, one count: the ledger's landing-attempt loop (here the memory journal's), whoever starts the attempt.
  const journal = new MemoryLandingJournal();
  const outcomes: string[] = [];
  let k = 0;
  const result = await landWhenReady(
    w.common,
    async () => {
      const r = await land(w.req, deps(journal));
      outcomes.push(r.kind === 'checked' ? `${r.outcome}/${r.next}` : r.kind === 'not-auto-landed' ? `${r.reason}/${r.wi}` : r.kind);
      return r;
    },
    {
      recheckMs: 60_000,
      minAttemptIntervalMs: 0,
      // Something changes in the repository after each attempt (here: an unrelated branch appears).
      onWaiting: () => {
        setTimeout(() => fx.raw(['update-ref', `refs/heads/poke-${k++}`, w.A], w.repo), 50);
      },
    },
  );
  assert.equal(result.ended, 'exhausted');
  assert.equal(result.attempts, 5);
  assert.deepEqual(outcomes, ['B/new-attempt', 'B/new-attempt', 'B/new-attempt', 'B/new-attempt', 'attempts-exhausted/WI-08']);
  assert.equal([...journal.pushStageAttempts.values()][0]?.length, 4, 'the first attempt and 3 more entered the push stage');
  assert.equal(readFileSync(join(w.repo, 'f.txt'), 'utf8'), 'local edit\n', 'the local edit survived every attempt');
  assert.equal(fx.raw(['rev-parse', 'refs/heads/main'], w.repo), w.A);
  assert.equal(journal.notices.at(-1)?.wi, 'WI-08');
});

test('v42 class A: a new attempt after each change, but at most once per interval for the delivery; no count cap', async () => {
  const w = await world();
  raw(['worktree', 'add', '-q', '-f', join(fx.root, `L-${n++}`), 'main'], w.repo); // many: WI-01 every time
  const starts: number[] = [];
  const ac = new AbortController();
  let k = 0;
  const pokes: NodeJS.Timeout[] = [];
  const result = await landWhenReady(
    w.common,
    async (i) => {
      starts.push(Date.now());
      if (i === 4) ac.abort();
      return land(w.req, deps());
    },
    {
      recheckMs: 60_000,
      minAttemptIntervalMs: 600,
      signal: ac.signal,
      onWaiting: () => {
        pokes.push(setTimeout(() => fx.raw(['update-ref', `refs/heads/poke-${k++}`, w.A], w.repo), 20));
      },
    },
  );
  for (const t of pokes) clearTimeout(t);
  assert.equal(result.ended, 'aborted');
  assert.equal(result.attempts, 4, 'waiting is not a loop: no cap on class A attempts');
  // The interval is kept from the moment landWhenReady starts an attempt; these stamps are taken a moment later
  // inside the attempt (Date.now() has 1 ms granularity): allow 2 ms.
  for (let i = 1; i < starts.length; i++) assert.ok((starts[i] as number) - (starts[i - 1] as number) >= 598, `attempt ${i + 1} came ${(starts[i] as number) - (starts[i - 1] as number)} ms after the previous one`);
});
