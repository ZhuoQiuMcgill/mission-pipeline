// 6.6 v36-v40 on real repositories:
// - v38, v39: every landing command names its repository; the push sends from and
//   to the common dir's absolute path, the receiving side gets no locator, and the
//   filter in the whitelisted position sees the locators of the worktree actually
//   updated. W0 (feature) and W1 (main) start with identical content A; the
//   delivery B lands in W1 only, from the main worktree, from a subdirectory of a
//   linked worktree, with the main worktree as the target, and in a bare common
//   repository;
// - v36, v37: the fixed set is bound by descriptor, so re-pointing a worktree's
//   `.git` file, or moving the common dir and repairing the registration, after
//   the identity check and before git reads anything, changes nothing: no filter
//   marker, writes only in the admitted directory objects;
// - v40: duplicate checkouts are refused, a forced second checkout before the
//   pre-push re-check aborts the push, one after it is reported as "branch
//   advanced, files stale" with the recovery command.
// git-lfs is not installed here: a stand-in speaking git's long-running filter
// protocol sits in the whitelisted position and logs the locators it sees.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { after, before, test } from 'node:test';
import { id, type GitOid, type MissionId, type OpId } from '../src/common/ids.ts';
import { land, MemoryLandingJournal, type LandingDeps, type LandingReport, type LandingRequest, type PhaseRecord } from '../src/git/landing.ts';
import { encodeLfsPointer, lfsObjectPath, lfsPointerFor } from '../src/git/lfs.ts';
import { discoverRepo } from '../src/git/objects.ts';
import { createProgramRef, deliveryRef } from '../src/git/refs.ts';
import { readTransformDescription } from '../src/git/representation.ts';
import { makeFixture, rawCommit, readTreeContent, sameTreeContent, writeExecutable, type FileSpec, type Fixture } from './git-fixtures.test.ts';

let fx: Fixture;
before(() => {
  fx = makeFixture('landing-loc');
});
after(() => fx.cleanup());

const M = id<MissionId>('m1');
const NO_LEDGER = { reserve: { recoveryReserveBytes: 0, evaluatorPoolBytes: 0 }, sharesVolume: () => false };
let n = 0;

/** A stand-in for git-lfs: git's long-running filter protocol, LFS pointers, and a log of what it sees. */
function standInLfs(log: string, store: string, onSmudge: readonly string[] | null = null): string {
  const path = join(fx.root, `lfs-standin-${n++}`);
  writeExecutable(
    path,
    `#!/usr/bin/python3 -I
import sys, os, json, hashlib
LOG = ${JSON.stringify(log)}
STORE = ${JSON.stringify(store)}
ON_SMUDGE = json.loads(${JSON.stringify(JSON.stringify(onSmudge))})
def log(ev, path=None):
    with open(LOG, 'a') as f:
        f.write(json.dumps({'ev': ev, 'path': path, 'GIT_DIR': os.environ.get('GIT_DIR'), 'GIT_WORK_TREE': os.environ.get('GIT_WORK_TREE'),
                            'GIT_COMMON_DIR': os.environ.get('GIT_COMMON_DIR'), 'cwd': os.getcwd()}) + '\\n')
inp, out = sys.stdin.buffer, sys.stdout.buffer
def rd():
    h = inp.read(4)
    if len(h) < 4: return None
    n = int(h, 16)
    return b'' if n == 0 else inp.read(n - 4)
def wr(b): out.write(b'%04x' % (len(b) + 4) + b)
def fl():
    out.write(b'0000'); out.flush()
def lines():
    xs = []
    while True:
        p = rd()
        if p is None: sys.exit(0)
        if p == b'': return xs
        xs.append(p.decode().rstrip('\\n'))
def content():
    cs = []
    while True:
        p = rd()
        if p is None: sys.exit(1)
        if p == b'': return b''.join(cs)
        cs.append(p)
def oid_of(data):
    t = data.decode('utf-8', 'replace').split('\\n')
    if len(t) >= 3 and t[0].startswith('version https://git-lfs') and t[1].startswith('oid sha256:'): return t[1][len('oid sha256:'):].strip()
    return None
def pointer(data):
    return b'version https://git-lfs.github.com/spec/v1\\noid sha256:%s\\nsize %d\\n' % (hashlib.sha256(data).hexdigest().encode(), len(data))
if sys.argv[1:2] == ['filter-process']:
    log('start')
    lines(); wr(b'git-filter-server\\n'); wr(b'version=2\\n'); fl()
    lines(); wr(b'capability=clean\\n'); wr(b'capability=smudge\\n'); fl()
    while True:
        kv = dict(x.split('=', 1) for x in lines() if '=' in x)
        data = content()
        cmd, path = kv.get('command'), kv.get('pathname')
        log(cmd, path)
        if cmd == 'clean':
            res = data if oid_of(data) else pointer(data)
        elif cmd == 'smudge' and oid_of(data):
            o = oid_of(data)
            with open(os.path.join(STORE, o[0:2], o[2:4], o), 'rb') as f: res = f.read()
            if ON_SMUDGE is not None:
                import subprocess
                subprocess.run(ON_SMUDGE, check=False, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        else:
            res = data
        wr(b'status=success\\n'); fl()
        for i in range(0, len(res), 65516): wr(res[i:i + 65516])
        fl(); fl()
else:
    # Per-file mode (v48: a landing configures no filter.lfs.process; only the checkout's smudge runs git-lfs).
    data = sys.stdin.buffer.read()
    cmd = sys.argv[1] if len(sys.argv) > 1 else '?'
    log(cmd, sys.argv[-1])
    if cmd == 'smudge' and oid_of(data):
        o = oid_of(data)
        with open(os.path.join(STORE, o[0:2], o[2:4], o), 'rb') as f: res = f.read()
        if ON_SMUDGE is not None:
            import subprocess
            subprocess.run(ON_SMUDGE, check=False, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        sys.stdout.buffer.write(res)
    elif cmd == 'clean':
        sys.stdout.buffer.write(data if oid_of(data) else pointer(data))
    else:
        sys.stdout.buffer.write(data)
`,
  );
  return path;
}

type Kind = 'main-W0' | 'main-W1' | 'bare';

interface World {
  kind: Kind;
  common: string;
  W0: string;
  W1: string;
  W0gitDir: string;
  W1gitDir: string;
  A: GitOid;
  B: GitOid;
  Y: Buffer;
  req: LandingRequest;
  log: string;
  lfs: string;
}

const X = Buffer.from('lfs payload A\n');
const Yc = Buffer.from('lfs payload B, longer\n');

function raw(args: readonly string[], cwd: string): string {
  return fx.raw(['-c', 'core.hooksPath=/dev/null', ...args], cwd);
}

/**
 * W0 on feature and W1 on main, both at A (identical content, including an LFS
 * path); the delivery B changes f.txt and the LFS object. `kind`: which worktree
 * is the repository's main one, or a bare common repository with both linked.
 */
async function world(kind: Kind, start: 'W0' | 'W0/sub' | 'W1/sub'): Promise<World> {
  const base = join(fx.root, `${kind}-${n++}`);
  mkdirSync(base);
  const repo = kind === 'bare' ? join(base, 'repo.git') : join(base, kind === 'main-W0' ? 'W0' : 'W1');
  fx.raw(['init', '-q', ...(kind === 'bare' ? ['--bare'] : []), '-b', 'main', repo], fx.root);
  const common = realpathSync(kind === 'bare' ? repo : join(repo, '.git'));
  const log = join(base, 'filter.log');
  const lfs = standInLfs(log, join(common, 'lfs', 'objects'));
  // The real configuration uses the stand-in too, so the fixture's own checkouts smudge correctly.
  fx.raw(['config', 'filter.lfs.process', `${lfs} filter-process`], repo);
  fx.raw(['config', 'filter.lfs.required', 'true'], repo);
  for (const c of [X, Yc]) {
    const p = lfsObjectPath(common, lfsPointerFor(c).oid);
    mkdirSync(join(p, '..'), { recursive: true });
    writeFileSync(p, c);
  }
  const files: Record<string, FileSpec> = {
    '.gitattributes': '*.bin filter=lfs diff=lfs merge=lfs -text\n',
    'f.txt': 'one\n',
    'sub/keep.txt': 'keep\n',
    'data.bin': encodeLfsPointer(lfsPointerFor(X)),
  };
  const A = rawCommit(fx, repo, files, null, 'A');
  const B = rawCommit(fx, repo, { ...files, 'f.txt': 'two\n', 'data.bin': encodeLfsPointer(lfsPointerFor(Yc)) }, A, 'B');
  fx.raw(['update-ref', 'refs/heads/main', A], repo);
  fx.raw(['branch', 'feature', A], repo);
  const W0 = join(base, 'W0');
  const W1 = join(base, 'W1');
  if (kind === 'main-W0') {
    raw(['reset', '-q', '--hard', A], W0);
    raw(['switch', '-q', 'feature'], W0);
    raw(['worktree', 'add', '-q', W1, 'main'], W0);
  } else if (kind === 'main-W1') {
    raw(['reset', '-q', '--hard', A], W1);
    raw(['worktree', 'add', '-q', W0, 'feature'], W1);
  } else {
    raw(['worktree', 'add', '-q', W0, 'feature'], repo);
    raw(['worktree', 'add', '-q', W1, 'main'], repo);
  }
  const gitDirOf = (w: string): string => realpathSync(fx.raw(['rev-parse', '--path-format=absolute', '--git-dir'], w));
  const layout = await discoverRepo(fx.git, W1);
  const d = await readTransformDescription(fx.git, layout, fx.user);
  const op = id<OpId>(`op${n++}`);
  assert.equal((await createProgramRef(fx.git, layout, deliveryRef(M, op), B)).kind, 'created');
  writeFileSync(log, '');
  const startPath = start === 'W0' ? W0 : start === 'W0/sub' ? join(W0, 'sub') : join(W1, 'sub');
  return {
    kind,
    common,
    W0,
    W1,
    W0gitDir: gitDirOf(W0),
    W1gitDir: gitDirOf(W1),
    A,
    B,
    Y: Yc,
    log,
    lfs,
    req: { key: { mission: M, op }, repoPath: startPath, targetBranch: 'main', base: A, delivery: B, description: d, user: fx.user, ledger: NO_LEDGER, mainCheckout: W1 },
  };
}

function deps(w: World, journal = new MemoryLandingJournal(), extra: Partial<LandingDeps> = {}): LandingDeps {
  return { git: fx.git, journal, scratchDir: fx.root, ...extra };
}

function checked(r: LandingReport): Extract<LandingReport, { kind: 'checked' }> {
  assert.equal(r.kind, 'checked', JSON.stringify(r));
  return r as Extract<LandingReport, { kind: 'checked' }>;
}

function sha(p: string): string {
  return createHash('sha256').update(readFileSync(p)).digest('hex');
}

/** Everything a worktree is: HEAD, index bytes, files. */
function snapshot(root: string, gitDir: string): { head: string; index: string; files: ReturnType<typeof readTreeContent> } {
  return { head: readFileSync(join(gitDir, 'HEAD'), 'utf8'), index: sha(join(gitDir, 'index')), files: readTreeContent(root) };
}

interface FilterEvent {
  ev: string;
  path: string | null;
  GIT_DIR: string | null;
  GIT_WORK_TREE: string | null;
  GIT_COMMON_DIR: string | null;
  cwd: string;
}

function events(w: World): FilterEvent[] {
  return readFileSync(w.log, 'utf8')
    .split('\n')
    .filter((l) => l !== '')
    .map((l) => JSON.parse(l) as FilterEvent);
}

function rev(dir: string, r: string): string {
  return fx.raw(['rev-parse', r], dir);
}

/** W1 moved to B as a whole; W0 did not move at all; the filter saw only W1's locators. */
function assertLandedInW1Only(w: World, rep: LandingReport, w0Before: ReturnType<typeof snapshot>): void {
  // What the filter saw during the landing (read first: the checks below run git in W1 with its real config).
  const ev = events(w);
  const c = checked(rep);
  assert.equal(c.verification.overall, 'expected', JSON.stringify(c.verification));
  assert.equal(c.verification.landed, true);
  // W1: branch, index and files together.
  assert.equal(rev(w.W1, 'HEAD'), w.B);
  assert.equal(fx.raw(['symbolic-ref', 'HEAD'], w.W1), 'refs/heads/main');
  assert.equal(raw(['write-tree'], w.W1), rev(w.W1, `${w.B}^{tree}`), "W1's index is B's tree");
  assert.equal(readFileSync(join(w.W1, 'f.txt'), 'utf8'), 'two\n');
  assert.ok(readFileSync(join(w.W1, 'data.bin')).equals(w.Y), 'the LFS object was smudged into W1');
  // W0: nothing at all.
  const after0 = snapshot(w.W0, w.W0gitDir);
  assert.equal(after0.head, w0Before.head);
  assert.equal(after0.index, w0Before.index, "W0's index file is byte-identical");
  assert.deepEqual(sameTreeContent(w0Before.files, after0.files), [], "W0's files are unchanged");
  // v50: the landing never runs git-lfs: the repository's own LFS filter (the stand-in) saw nothing; the
  // program's smudge read the object from the local store (the bytes above).
  assert.deepEqual(ev, [], `git-lfs ran during the landing: ${JSON.stringify(ev)}`);
}

for (const [kind, start] of [
  ['main-W0', 'W0'],
  ['main-W0', 'W1/sub'],
  ['main-W1', 'W0/sub'],
  ['bare', 'W0/sub'],
] as const) {
  test(`v38/v39: W0 on feature, W1 on main, identical content; push B lands in W1 only (${kind}, started from ${start})`, async () => {
    const w = await world(kind, start);
    const before0 = snapshot(w.W0, w.W0gitDir);
    const journal = new MemoryLandingJournal();
    const rep = await land(w.req, deps(w, journal));
    assertLandedInW1Only(w, rep, before0);
    assert.deepEqual(journal.notices, []);
  });
}

// ---------------------------------------------------------------- v36, v37: after the identity check, before git reads

/** A standalone repository whose config runs a marker filter on *.txt: what a re-pointed `.git` file would lead git to. */
function evilGitDir(w: World, mark: string): string {
  const evil = join(fx.root, `evil-${n++}`);
  fx.raw(['init', '-q', evil], fx.root);
  const A = rawCommit(fx, evil, { 'f.txt': 'one\n' }, null, 'evil');
  raw(['reset', '-q', '--hard', A], evil);
  // Armed only now, so setting it up leaves no mark.
  fx.raw(['config', 'filter.evil.clean', `sh -c 'echo evil-clean >> ${mark}; cat'`], evil);
  fx.raw(['config', 'filter.evil.smudge', `sh -c 'echo evil-smudge >> ${mark}; cat'`], evil);
  writeFileSync(join(evil, '.git', 'info', 'attributes'), '*.txt filter=evil\n');
  return realpathSync(join(evil, '.git'));
}

function dirDigest(dir: string): string {
  const h = createHash('sha256');
  const walk = (rel: string): void => {
    for (const name of readdirSync(join(dir, rel)).sort()) {
      const p = rel === '' ? name : `${rel}/${name}`;
      const st = statSync(join(dir, p));
      if (st.isDirectory()) walk(p);
      else h.update(`${p}\0`).update(readFileSync(join(dir, p)));
    }
  };
  walk('');
  return h.digest('hex');
}

for (const kind of ['main-W0', 'bare'] as const) {
  test(`v37: W1's .git file re-pointed after the identity check, before git reads it: nothing follows it (${kind})`, async () => {
    const w = await world(kind, 'W0');
    const mark = join(fx.root, `mark-${n++}`);
    const evil = evilGitDir(w, mark);
    const evilBefore = dirDigest(evil);
    const dotGit = join(w.W1, '.git');
    const recorded = readFileSync(dotGit);
    const before0 = snapshot(w.W0, w.W0gitDir);
    let pointed = 0;
    const rep = await land(
      w.req,
      deps(w, new MemoryLandingJournal(), {
        onViewBuilt: (view) => {
          view.afterIdentityCheck = (argv) => {
            if (!argv.includes('push')) return;
            writeFileSync(dotGit, `gitdir: ${evil}\n`);
            pointed++;
          };
        },
      }),
    );
    assert.equal(pointed, 1);
    assert.equal(existsSync(mark) ? readFileSync(mark, 'utf8') : '', '', 'no filter of the re-pointed git dir ran');
    assert.equal(dirDigest(evil), evilBefore, 'nothing was written where the re-pointed .git leads');
    const pointedTo = readFileSync(dotGit);
    writeFileSync(dotGit, recorded);
    assertLandedInW1Only(w, rep, before0);
    // Control: the re-pointing is live. A discovering git in W1 does follow it and runs its filter.
    writeFileSync(dotGit, pointedTo);
    raw(['status', '--porcelain'], w.W1);
    assert.match(readFileSync(mark, 'utf8'), /evil-clean/);
    writeFileSync(dotGit, recorded);
  });

  test(`v37: the common dir moved and its registration repaired after the identity check: writes land only in the admitted directories (${kind})`, async () => {
    const w = await world(kind, 'W0');
    const mark = join(fx.root, `mark-${n++}`);
    const moved = join(fx.root, `moved-${n++}`);
    const before0 = snapshot(w.W0, w.W0gitDir);
    let impostorBefore = '';
    const rep = await land(
      w.req,
      deps(w, new MemoryLandingJournal(), {
        onViewBuilt: (view) => {
          view.afterIdentityCheck = (argv) => {
            if (!argv.includes('push')) return;
            renameSync(w.common, moved);
            // An impostor at the old path, with a filter and a hook that would mark any use of it.
            fx.raw(['init', '-q', '--bare', w.common], fx.root);
            fx.raw(['config', 'filter.lfs.process', `sh -c 'echo impostor >> ${mark}'`], w.common);
            writeExecutable(join(w.common, 'hooks', 'post-receive'), `#!/bin/sh\necho impostor-hook >> '${mark}'\n`);
            // The registration repaired to the new place.
            fx.raw(['--git-dir', moved, '-c', 'core.hooksPath=/dev/null', 'worktree', 'repair', w.W1, ...(kind === 'bare' ? [w.W0] : [])], fx.root);
            impostorBefore = dirDigest(w.common);
          };
        },
      }),
    );
    const ev = events(w); // before any git runs in W1 with its real configuration
    const c = checked(rep);
    assert.equal(c.push !== 'unknown' && c.push.kind, 'updated', JSON.stringify(c.push));
    // The admitted directory objects took the writes, wherever they are now.
    assert.equal(fx.raw(['--git-dir', moved, 'rev-parse', 'refs/heads/main'], fx.root), w.B);
    assert.equal(readFileSync(join(w.W1, 'f.txt'), 'utf8'), 'two\n');
    assert.ok(readFileSync(join(w.W1, 'data.bin')).equals(w.Y));
    const w1GitDirNow = join(moved, 'worktrees', 'W1');
    assert.equal(fx.raw(['--git-dir', w1GitDirNow, '--work-tree', w.W1, 'write-tree'], w.W1), fx.raw(['--git-dir', moved, 'rev-parse', `${w.B}^{tree}`], fx.root));
    // The impostor at the recorded path was never used: no ref, no object, no filter, no hook.
    assert.equal(dirDigest(w.common), impostorBefore, 'nothing was written into the impostor');
    assert.equal(existsSync(mark) ? readFileSync(mark, 'utf8') : '', '');
    // W0 untouched; git-lfs never ran (v50: the program's own smudge read the admitted LFS store).
    const after0Files = readTreeContent(w.W0);
    assert.deepEqual(sameTreeContent(before0.files, after0Files), []);
    assert.deepEqual(ev, [], JSON.stringify(ev));
    // Verification cannot look inside the replaced common dir, and says so instead of guessing.
    assert.equal(c.verification.overall, 'cannot-determine');
    assert.ok(c.verification.identityChanged.some((p) => p.worktree === null && p.problem === 'replaced'), JSON.stringify(c.verification.identityChanged));
  });
}

// ---------------------------------------------------------------- v40: the target branch checked out once

test('v40: two pre-existing worktrees on the target at A: refused (WI-01); the branch, both indexes and both file sets are unchanged', async () => {
  const w = await world('main-W1', 'W0');
  raw(['switch', '-q', '--ignore-other-worktrees', 'main'], w.W0); // a second checkout of main, past git's guard
  const s0 = snapshot(w.W0, w.W0gitDir);
  const s1 = snapshot(w.W1, w.W1gitDir);
  const journal = new MemoryLandingJournal();
  const rep = await land(w.req, deps(w, journal));
  assert.equal(rep.kind === 'not-auto-landed' && `${rep.reason}/${rep.wi}`, 'target-in-several-worktrees/WI-01', JSON.stringify(rep));
  assert.deepEqual(rep.kind === 'not-auto-landed' ? [...rep.paths].sort() : [], [w.W0, w.W1].sort());
  assert.equal(rev(w.W1, 'refs/heads/main'), w.A);
  assert.equal(fx.raw(['rev-parse', deliveryRef(M, w.req.key.op)], w.W1), w.B, 'the delivery ref is kept');
  for (const [s, root, gd] of [
    [s0, w.W0, w.W0gitDir],
    [s1, w.W1, w.W1gitDir],
  ] as const) {
    const now = snapshot(root, gd);
    assert.equal(now.head, s.head);
    assert.equal(now.index, s.index);
    assert.deepEqual(sameTreeContent(s.files, now.files), []);
  }
  assert.deepEqual(
    journal.notices.map((x) => [x.wi, x.category]),
    [['WI-01', 'landing-occupancy']],
  );
  assert.match(journal.notices[0]?.defaultAction ?? '', /at least every 10 minutes/);
});

test('v40: a forced second checkout after the view was built, before the pre-push re-check: aborted, nothing pushed', async () => {
  const w = await world('main-W1', 'W0');
  const journal = new MemoryLandingJournal();
  journal.onBeginPhase = (r: PhaseRecord) => {
    if (r.phase === 'record-pre-state') raw(['switch', '-q', '--ignore-other-worktrees', 'main'], w.W0);
  };
  const rep = await land(w.req, deps(w, journal));
  // v42: the pre-push re-check ends this attempt before the push (class A, WI-06); the next check classifies again.
  assert.equal(rep.kind === 'not-auto-landed' && `${rep.reason}/${rep.wi}`, 'occupancy-changed/WI-06', JSON.stringify(rep));
  assert.equal(rev(w.W1, 'refs/heads/main'), w.A, 'no push');
  const phases = (await journal.load(w.req.key))?.phases.map((p) => p.phase);
  assert.deepEqual(phases, ['authorize', 'admit', 'record-pre-state']);
  assert.equal(readFileSync(join(w.W0, 'f.txt'), 'utf8'), 'one\n');
});

test('v40: a forced checkout after the pre-push re-check: pushed, and that worktree is "branch advanced, files stale" with the command', async () => {
  const w = await world('main-W1', 'W0');
  const journal = new MemoryLandingJournal();
  journal.onBeginPhase = (r: PhaseRecord) => {
    if (r.phase === 'push') raw(['switch', '-q', '--ignore-other-worktrees', 'main'], w.W0);
  };
  const c = checked(await land(w.req, deps(w, journal)));
  assert.equal(c.verification.landed, true);
  assert.equal(readFileSync(join(w.W1, 'f.txt'), 'utf8'), 'two\n', 'the main checkout was updated');
  const v0 = c.verification.worktrees.find((x) => x.worktree === w.W0);
  assert.equal(v0?.kind, 'branch-advanced-files-stale', JSON.stringify(c.verification.worktrees));
  assert.equal(c.verification.overall, 'branch-advanced-files-stale');
  const recovery = v0?.kind === 'branch-advanced-files-stale' ? v0.recovery : null;
  // v47, v48: the delivery's attributes, sparse checkout off, no submodule recursion, no replace objects.
  assert.match(recovery ?? '', new RegExp(`git -C ${w.W0} --attr-source=${w.B} -c core.sparseCheckout=false -c submodule.recurse=false -c core.useReplaceRefs=false read-tree -u -m ${w.A} ${w.B}`));
  assert.deepEqual(journal.notices.map((x) => x.wi), ['WI-04']);
  // W0 is HEAD main@B with A's index and files; the command brings it along.
  assert.equal(rev(w.W0, 'HEAD'), w.B);
  assert.equal(readFileSync(join(w.W0, 'f.txt'), 'utf8'), 'one\n');
  const cmd = (recovery ?? '').split('  #')[0] as string;
  const p = spawnSync('sh', ['-c', cmd], { env: fx.env });
  assert.equal(p.status, 0, p.stderr.toString());
  assert.equal(readFileSync(join(w.W0, 'f.txt'), 'utf8'), 'two\n');
  assert.ok(readFileSync(join(w.W0, 'data.bin')).equals(w.Y));
  assert.equal(raw(['status', '--porcelain'], w.W0), '');
});

// ---------------------------------------------------------------- v42: classified by the check, never by git's message

test('v42: the receiving side updates the worktree, then the ref transaction fails on a stale lease: class C, not B; reported, never redone', async () => {
  const w = await world('main-W1', 'W0');
  // After the hook has updated W1 (its update happens before the ref transaction), someone else moves main:
  // the transaction's expected old value no longer holds.
  const other = rawCommit(fx, w.W1, { '.gitattributes': '*.bin filter=lfs diff=lfs merge=lfs -text\n', 'f.txt': 'other\n', 'sub/keep.txt': 'keep\n', 'data.bin': encodeLfsPointer(lfsPointerFor(X)) }, w.A, 'other');
  const barrier = join(fx.root, `barrier-${n++}`);
  mkdirSync(barrier);
  const journal = new MemoryLandingJournal();
  const pending = land(w.req, deps(w, journal, { checkoutBarrier: { at: 'after-read-tree', dir: barrier } }));
  while (!existsSync(join(barrier, 'ready'))) await new Promise((res) => setTimeout(res, 10));
  fx.raw(['update-ref', 'refs/heads/main', other, w.A], w.W1);
  writeFileSync(join(barrier, 'go'), '');
  const rep = checked(await pending);
  // git refused (the ref update failed), but W1's index and files were already written by the receiving side.
  assert.notEqual(rep.push !== 'unknown' && rep.push.kind, 'updated', JSON.stringify(rep.push));
  assert.equal(rev(w.W1, 'refs/heads/main'), other);
  assert.equal(readFileSync(join(w.W1, 'f.txt'), 'utf8'), 'two\n', 'the receiving side had updated W1 before its ref transaction failed');
  assert.equal(rep.outcome, 'C', 'something changed: never B, whatever git said');
  assert.equal(rep.next, null);
  assert.equal(rep.verification.landed, false);
  // v45: W1 (the approved worktree) is neither untouched nor coherent with its HEAD (main moved to someone else's commit).
  assert.match(rep.why, /neither untouched nor coherent/);
  const v1 = rep.verification.worktrees.find((x) => x.worktree === w.W1);
  assert.equal(v1?.kind, 'cannot-determine', JSON.stringify(rep.verification.worktrees));
  assert.deepEqual(journal.notices.map((x) => x.wi).sort(), ['WI-04', 'WI-06']);
  assert.match(journal.notices.find((x) => x.wi === 'WI-06')?.trigger ?? '', /class C/);
});
