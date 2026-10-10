import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import {
  encodeLfsPointer,
  lfsClean,
  lfsObjectPath,
  lfsPointerFor,
  LFS_SPEC_URL,
  parseLfsPointer,
} from '../src/git/lfs.ts';
import { batchCheck, discoverRepo, gitObjectId, type RepoLayout } from '../src/git/objects.ts';
import {
  AttributeEvaluator,
  canonicalize,
  checkLfsObjectsPresent,
  MissingObjectsError,
  crlfToGit,
  crlfToWorktree,
  identToGit,
  identToWorktree,
  materializeSnapshot,
  planCommit,
  readTransformDescription,
  RepresentationError,
  storeLfsObject,
  transformDescriptionHash,
  type TransformDescription,
} from '../src/git/representation.ts';
import { blobOf, checkoutMain, initRepo, makeFixture, rawCommit, readTreeContent, sameTreeContent, type FileSpec, type Fixture } from './git-fixtures.test.ts';

let fx: Fixture;
before(() => {
  fx = makeFixture('repr');
});
after(() => fx.cleanup());

const ident = { name: 'Mission Pipeline', email: 'engine@example.invalid', date: '1700000100 +0000' };

interface Setup {
  repo: string;
  layout: RepoLayout;
  base: string;
  d: TransformDescription;
  ev: AttributeEvaluator;
}

let counter = 0;
async function setup(files: Record<string, FileSpec>, config: Record<string, string> = {}): Promise<Setup> {
  const repo = initRepo(fx, `r${counter++}`);
  for (const [k, v] of Object.entries(config)) fx.raw(['config', k, v], repo);
  const base = rawCommit(fx, repo, files, null, 'base');
  checkoutMain(fx, repo, base);
  const layout = await discoverRepo(fx.git, repo);
  const d = await readTransformDescription(fx.git, layout, fx.user);
  const ev = await AttributeEvaluator.create(fx.git, layout, d, fx.root);
  return { repo, layout, base, d, ev };
}

function dir(name: string): string {
  return join(fx.root, `${name}-${counter++}`);
}

test('conversion units follow convert.c on hand-checked vectors', () => {
  const b = (s: string) => Buffer.from(s, 'latin1');
  assert.equal(crlfToWorktree(b('a\nb\r\nc\n'), 'text-crlf').toString('latin1'), 'a\r\nb\r\nc\r\n');
  assert.equal(crlfToWorktree(b('a\nb\r\nc\n'), 'auto-crlf').toString('latin1'), 'a\nb\r\nc\n', 'safer autocrlf leaves mixed files');
  assert.equal(crlfToWorktree(b('a\nb\n'), 'text-input').toString('latin1'), 'a\nb\n');
  assert.equal(crlfToGit(b('a\r\nb\rc\r\n'), 'text-input', null).toString('latin1'), 'a\nb\rc\n');
  assert.equal(crlfToGit(b('a\r\nb\r\n'), 'auto-crlf', b('x\r\n')).toString('latin1'), 'a\r\nb\r\n', 'CRLF already recorded: keep');
  assert.equal(crlfToGit(b('a\r\nb\r\n'), 'auto-crlf', b('x\n')).toString('latin1'), 'a\nb\n');
  const oid = 'a'.repeat(40);
  assert.equal(identToWorktree(b('$Id$\n'), oid).toString('latin1'), `$Id: ${oid} $\n`);
  assert.equal(identToWorktree(b('$Id: foo bar $\n'), oid).toString('latin1'), '$Id: foo bar $\n', 'foreign ids are kept on checkout');
  assert.equal(identToGit(b('$Id: foo bar $\n')).toString('latin1'), '$Id$\n', 'but collapsed on add (git is asymmetric)');
  assert.equal(identToGit(b(`$Id: ${oid} $\nx $Id$`)).toString('latin1'), '$Id$\nx $Id$');
  assert.equal(identToGit(b('$Id: no\nclose $')).toString('latin1'), '$Id: no\nclose $');
});

test('LFS pointers: canonical encoding, tolerant parsing, empty files, extensions unsupported, clean passes pointers through', () => {
  const content = randomBytes(5000);
  const p = lfsPointerFor(content);
  const ptr = encodeLfsPointer(p);
  assert.equal(ptr.toString(), `version ${LFS_SPEC_URL}\noid sha256:${p.oid}\nsize 5000\n`);
  assert.deepEqual(parseLfsPointer(ptr), { kind: 'pointer', pointer: p });
  assert.deepEqual(parseLfsPointer(Buffer.from(ptr.toString().replace(/\n/g, '\r\n'))), { kind: 'pointer', pointer: p }, 'CRLF tolerated like git-lfs');
  assert.deepEqual(parseLfsPointer(Buffer.from(`  ${ptr.toString()}\n\n`)), { kind: 'pointer', pointer: p });
  assert.equal(parseLfsPointer(Buffer.from('hello')).kind, 'not-pointer');
  assert.equal(parseLfsPointer(Buffer.concat([ptr, Buffer.alloc(1100, 32)])).kind, 'not-pointer', '1024 bytes or more is never a pointer');
  assert.equal(parseLfsPointer(Buffer.from(`version ${LFS_SPEC_URL}\next-0-foo sha256:${p.oid}\noid sha256:${p.oid}\nsize 1\n`)).kind, 'unsupported');
  assert.equal(parseLfsPointer(Buffer.from(`version ${LFS_SPEC_URL}\nsize 1\noid sha256:${p.oid}\n`)).kind, 'not-pointer', 'keys out of order');
  assert.equal(encodeLfsPointer({ oid: lfsPointerFor(Buffer.alloc(0)).oid, size: 0 }).length, 0, 'an empty file has an empty pointer');
  assert.deepEqual(lfsClean(Buffer.alloc(0)), { blob: Buffer.alloc(0), object: null });
  assert.deepEqual(lfsClean(ptr), { blob: ptr, object: null }, 'content that already is a pointer stays as it is');
  const cleaned = lfsClean(content);
  assert.deepEqual(cleaned.object, p);
  assert.ok(cleaned.blob.equals(ptr));
});

test('transform description: effective settings from the user configuration, hashed; empty attribute files are absent', async () => {
  const s = await setup({ 'a.txt': 'x\n' });
  try {
    assert.equal(s.d.autocrlf, 'false');
    assert.equal(s.d.eol, 'unset');
    assert.equal(s.d.attributes.info, null);
    const h0 = transformDescriptionHash(s.d);
    mkdirSync(join(s.layout.commonDir, 'info'), { recursive: true });
    writeFileSync(join(s.layout.commonDir, 'info', 'attributes'), '');
    assert.equal(transformDescriptionHash(await readTransformDescription(fx.git, s.layout, fx.user)), h0, 'empty info/attributes equals none');
    // The user's global config and global attributes are part of the effective settings.
    writeFileSync(join(fx.home, '.gitconfig'), '[core]\n\tautocrlf = input\n');
    mkdirSync(join(fx.home, '.config', 'git'), { recursive: true });
    writeFileSync(join(fx.home, '.config', 'git', 'attributes'), '*.md text\n');
    try {
      const d2 = await readTransformDescription(fx.git, s.layout, fx.user);
      assert.equal(d2.autocrlf, 'input');
      assert.equal(d2.attributes.global, '*.md text\n');
      assert.notEqual(transformDescriptionHash(d2), h0);
      fx.raw(['config', 'core.autocrlf', 'false'], s.repo); // repository config overrides global
      assert.equal((await readTransformDescription(fx.git, s.layout, fx.user)).autocrlf, 'false');
      fx.raw(['config', '--unset', 'core.autocrlf'], s.repo);
      writeFileSync(join(s.layout.commonDir, 'config'), readFileSync(join(s.layout.commonDir, 'config'), 'utf8') + '[core]\n\tautocrlf\n');
      assert.equal((await readTransformDescription(fx.git, s.layout, fx.user)).autocrlf, 'true', 'a valueless key is true');
      fx.raw(['config', '--unset', 'core.autocrlf'], s.repo);
    } finally {
      rmSync(join(fx.home, '.gitconfig'));
      rmSync(join(fx.home, '.config'), { recursive: true });
    }
  } finally {
    s.ev.dispose();
  }
});

test('canonicalize, then verify: LF written on an eol=crlf path and an edited ident file come out canonical (7.1)', async () => {
  const s = await setup({
    '.gitattributes': '*.txt eol=crlf\n*.id ident\n*.sh text eol=lf\n',
    'a.txt': 'one\ntwo\n',
    'x.id': '$Id$\nline1\n',
    'run.sh': { exec: '#!/bin/sh\necho hi\n' },
    'keep.bin': Buffer.from([0, 1, 2, 13, 10, 255]),
    'link': { link: 'a.txt' },
    'gone.txt': 'bye\n',
  });
  try {
    const snap = dir('snap');
    const manifest = await materializeSnapshot({ git: fx.git, repo: s.layout, commit: s.base, attributes: s.ev, dest: snap });
    assert.equal(readFileSync(join(snap, 'a.txt'), 'latin1'), 'one\r\ntwo\r\n');
    const xidOld = fx.raw(['rev-parse', `${s.base}:x.id`], s.repo);
    assert.equal(readFileSync(join(snap, 'x.id'), 'latin1'), `$Id: ${xidOld} $\nline1\n`);
    assert.equal(lstatSync(join(snap, 'run.sh')).mode & 0o777, 0o755);
    assert.equal(readlinkSync(join(snap, 'link')), 'a.txt');
    assert.deepEqual(sameTreeContent(readTreeContent(s.repo), readTreeContent(snap)), [], 'snapshot equals git checkout');

    // The seat's edits, in worktree representation.
    writeFileSync(join(snap, 'new.txt'), 'n1\nn2\n'); // LF on an eol=crlf path: not canonical
    writeFileSync(join(snap, 'x.id'), `$Id: ${xidOld} $\nline1\nline2\n`); // edited, still carries the old id
    unlinkSync(join(snap, 'gone.txt'));
    symlinkSync('new.txt', join(snap, 'l2'));
    chmodSync(join(snap, 'run.sh'), 0o644);

    const candidateDir = dir('candidate');
    const r = await canonicalize({
      git: fx.git,
      repo: s.layout,
      base: manifest,
      snapshotDir: snap,
      attributes: s.ev,
      candidateDir,
      tempDir: fx.root,
      message: 'seat result\n',
      author: ident,
      committer: ident,
    });
    assert.equal(r.kind, 'canonical');
    if (r.kind !== 'canonical') return;
    assert.deepEqual(r.plan.added, ['l2', 'new.txt']);
    assert.deepEqual(r.plan.modified, ['x.id']);
    assert.deepEqual(r.plan.deleted, ['gone.txt']);
    assert.deepEqual(r.plan.modeChanged, ['run.sh']);
    assert.equal(fx.raw(['rev-parse', `${r.commit}^`], s.repo), s.base);
    // Repository representation.
    assert.equal(blobOf(fx, s.repo, r.commit, 'new.txt').toString('latin1'), 'n1\nn2\n');
    assert.equal(blobOf(fx, s.repo, r.commit, 'x.id').toString('latin1'), '$Id$\nline1\nline2\n');
    for (const p of ['a.txt', 'keep.bin', 'link']) {
      assert.equal(fx.raw(['rev-parse', `${r.commit}:${p}`], s.repo), fx.raw(['rev-parse', `${s.base}:${p}`], s.repo), `${p} keeps its blob`);
    }
    assert.match(fx.raw(['ls-tree', r.commit, 'run.sh'], s.repo), /^100644 /);
    // The canonical candidate differs from what the seat wrote, and equals git's checkout of the commit.
    const xidNew = fx.raw(['rev-parse', `${r.commit}:x.id`], s.repo);
    assert.notEqual(xidNew, xidOld);
    assert.equal(readFileSync(join(candidateDir, 'new.txt'), 'latin1'), 'n1\r\nn2\r\n');
    assert.equal(readFileSync(join(candidateDir, 'x.id'), 'latin1'), `$Id: ${xidNew} $\nline1\nline2\n`);
    const checkout = join(fx.root, `wt-${counter++}`);
    fx.raw(['-c', 'core.hooksPath=/dev/null', 'worktree', 'add', '-q', '--detach', checkout, r.commit], s.repo);
    assert.deepEqual(sameTreeContent(readTreeContent(checkout), readTreeContent(candidateDir)), [], 'candidate equals git checkout');
    assert.equal(r.candidate.commit, r.commit);

    // Idempotent: the canonical candidate, handed back unchanged, produces the same tree.
    const again = await planCommit({ git: fx.git, repo: s.layout, base: r.candidate, snapshotDir: candidateDir, attributes: s.ev });
    assert.equal(again.ok, true);
    if (again.ok) {
      assert.equal(again.plan.tree, r.tree);
      assert.deepEqual(again.plan.newBlobs, []);
    }
  } finally {
    s.ev.dispose();
  }
});

test('unsupported transforms: reported when materializing, refused before generating a commit, and no filter ever runs', async () => {
  const mark = join(fx.root, `filter-mark-${counter++}`);
  const s = await setup(
    {
      '.gitattributes': '*.dat filter=evil\n*.u16 working-tree-encoding=UTF-16\n*.u8 working-tree-encoding=UTF-8\n',
      'g.dat': 'payload\n',
      'w.u16': 'abc\n',
      'w.u8': 'abc\n',
      'a.txt': 'plain\n',
    },
    {
      'filter.evil.clean': `sh -c 'echo clean >> ${mark}; cat'`,
      'filter.evil.smudge': `sh -c 'echo smudge >> ${mark}; cat'`,
    },
  );
  rmSync(mark, { force: true }); // the fixture's own checkout ran the smudge filter
  try {
    const snap = dir('snap');
    const manifest = await materializeSnapshot({ git: fx.git, repo: s.layout, commit: s.base, attributes: s.ev, dest: snap });
    assert.deepEqual(
      manifest.unsupported.map((u) => u.path),
      ['g.dat', 'w.u16'],
    );
    assert.equal(readFileSync(join(snap, 'g.dat'), 'utf8'), 'payload\n', 'raw bytes, no filter');

    const plan = async () => planCommit({ git: fx.git, repo: s.layout, base: manifest, snapshotDir: snap, attributes: s.ev });
    writeFileSync(join(snap, 'w.u8'), 'abcd\n');
    assert.equal((await plan()).ok, true, 'working-tree-encoding=UTF-8 is a no-op in git and is supported');
    writeFileSync(join(snap, 'g.dat'), 'changed\n');
    const r1 = await plan();
    assert.equal(r1.ok, false);
    if (!r1.ok) {
      assert.equal(r1.rejection.code, 'unsupported-transform');
      assert.deepEqual(r1.rejection.paths, ['g.dat']);
    }
    writeFileSync(join(snap, 'g.dat'), 'payload\n');
    // An attribute edit that makes an untouched file use an unsupported filter is refused too.
    writeFileSync(join(snap, '.gitattributes'), '*.dat filter=evil\n*.u16 working-tree-encoding=UTF-16\n*.u8 working-tree-encoding=UTF-8\n*.txt filter=evil\n');
    const r2 = await plan();
    assert.equal(r2.ok, false);
    if (!r2.ok) assert.deepEqual(r2.rejection.paths, ['a.txt']);
    assert.equal(existsSync(mark), false, 'no content filter ran while materializing or planning');
  } finally {
    s.ev.dispose();
  }
});

test('Git LFS pointers are produced and resolved by the program itself (git-lfs is not needed)', async () => {
  const s = await setup({ '.gitattributes': '*.bin filter=lfs diff=lfs merge=lfs -text\n', 'readme': 'r\n' });
  try {
    // Put a pointer and its object into the repository, as a base.
    const smallContent = randomBytes(3000);
    const tmpObj = join(fx.root, `obj-${counter++}`);
    writeFileSync(tmpObj, smallContent);
    const small = lfsPointerFor(smallContent);
    storeLfsObject(s.layout.commonDir, tmpObj, small);
    const base = rawCommit(fx, s.repo, { '.gitattributes': '*.bin filter=lfs diff=lfs merge=lfs -text\n', 'small.bin': encodeLfsPointer(small), 'empty.bin': '' }, s.base, 'lfs base');
    const snap = dir('snap');
    const manifest = await materializeSnapshot({ git: fx.git, repo: s.layout, commit: base, attributes: s.ev, dest: snap });
    assert.ok(readFileSync(join(snap, 'small.bin')).equals(smallContent));
    assert.equal(readFileSync(join(snap, 'empty.bin')).length, 0);

    const big = randomBytes(100_000);
    writeFileSync(join(snap, 'big.bin'), big);
    const alreadyPointer = encodeLfsPointer(lfsPointerFor(Buffer.from('elsewhere')));
    writeFileSync(join(snap, 'ptr.bin'), alreadyPointer);
    const candidateDir = dir('candidate');
    const r = await canonicalize({
      git: fx.git,
      repo: s.layout,
      base: manifest,
      snapshotDir: snap,
      attributes: s.ev,
      candidateDir: candidateDir,
      tempDir: fx.root,
      message: 'lfs\n',
      author: ident,
      committer: ident,
      admit: (sizes) => {
        assert.deepEqual(sizes.lfsObjectSizes, [100_000]);
        return true;
      },
    }).catch((e: unknown) => e);
    // ptr.bin's object does not exist locally, so the candidate cannot be materialized: reported, typed.
    assert.ok(r instanceof RepresentationError && r.code === 'lfs-object-missing', String(r));
    unlinkSync(join(snap, 'ptr.bin'));
    rmSync(candidateDir, { recursive: true, force: true });
    const ok = await canonicalize({
      git: fx.git,
      repo: s.layout,
      base: manifest,
      snapshotDir: snap,
      attributes: s.ev,
      candidateDir,
      tempDir: fx.root,
      message: 'lfs\n',
      author: ident,
      committer: ident,
    });
    assert.equal(ok.kind, 'canonical');
    if (ok.kind !== 'canonical') return;
    const pointer = blobOf(fx, s.repo, ok.commit, 'big.bin');
    assert.ok(pointer.equals(encodeLfsPointer(lfsPointerFor(big))), 'the blob is the canonical pointer');
    assert.ok(readFileSync(lfsObjectPath(s.layout.commonDir, lfsPointerFor(big).oid)).equals(big), 'the object is in the LFS store');
    assert.ok(readFileSync(join(candidateDir, 'big.bin')).equals(big), 'the candidate holds the content');
    assert.equal(fx.raw(['rev-parse', `${ok.commit}:small.bin`], s.repo), fx.raw(['rev-parse', `${base}:small.bin`], s.repo));
  } finally {
    s.ev.dispose();
  }
});

test('core.symlinks=false and core.filemode=false keep git semantics', async () => {
  const s = await setup({ 'link': { link: 'target.txt' }, 'target.txt': 't\n', 'tool': 'x\n' }, { 'core.symlinks': 'false', 'core.filemode': 'false' });
  try {
    assert.equal(s.d.symlinks, false);
    assert.equal(s.d.fileMode, false);
    const snap = dir('snap');
    const manifest = await materializeSnapshot({ git: fx.git, repo: s.layout, commit: s.base, attributes: s.ev, dest: snap });
    assert.equal(lstatSync(join(snap, 'link')).isFile(), true);
    assert.equal(readFileSync(join(snap, 'link'), 'utf8'), 'target.txt');
    writeFileSync(join(snap, 'link'), 'other.txt');
    chmodSync(join(snap, 'tool'), 0o755);
    const r = await planCommit({ git: fx.git, repo: s.layout, base: manifest, snapshotDir: snap, attributes: s.ev });
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.plan.files.get('link')?.mode, '120000', 'still a symlink, now pointing at other.txt');
      assert.equal(r.plan.files.get('tool')?.mode, '100644', 'the executable bit is not read from the worktree');
      assert.deepEqual(r.plan.modeChanged, []);
    }
  } finally {
    s.ev.dispose();
  }
});

test('seat snapshots: special files, nested .git, excluded paths, non-UTF-8 names and a changed description are refused', async () => {
  const s = await setup({ 'a.txt': 'a\n', 'CLAUDE.md': 'instructions\n' });
  try {
    const exclude = (p: string) => p === 'CLAUDE.md';
    const fresh = async (): Promise<{ snap: string; manifest: Awaited<ReturnType<typeof materializeSnapshot>> }> => {
      const snap = dir('snap');
      const manifest = await materializeSnapshot({ git: fx.git, repo: s.layout, commit: s.base, attributes: s.ev, dest: snap, exclude });
      return { snap, manifest };
    };
    const plan = (snap: string, manifest: Awaited<ReturnType<typeof materializeSnapshot>>) =>
      planCommit({ git: fx.git, repo: s.layout, base: manifest, snapshotDir: snap, attributes: s.ev, exclude });

    let f = await fresh();
    assert.equal(existsSync(join(f.snap, 'CLAUDE.md')), false, 'excluded from the snapshot');
    const unchanged = await plan(f.snap, f.manifest);
    assert.equal(unchanged.ok && unchanged.plan.files.has('CLAUDE.md'), true, 'excluded paths are carried over from the base');

    execFileSync('mkfifo', [join(f.snap, 'pipe')]);
    let r = await plan(f.snap, f.manifest);
    assert.equal(!r.ok && r.rejection.code, 'special-file');

    f = await fresh();
    mkdirSync(join(f.snap, 'sub', '.git'), { recursive: true });
    r = await plan(f.snap, f.manifest);
    assert.equal(!r.ok && r.rejection.code, 'unsafe-path');

    f = await fresh();
    writeFileSync(join(f.snap, 'CLAUDE.md'), 'seat wrote this\n');
    r = await plan(f.snap, f.manifest);
    assert.equal(!r.ok && r.rejection.code, 'excluded-path-written');

    f = await fresh();
    writeFileSync(Buffer.concat([Buffer.from(f.snap + '/'), Buffer.from([0xff, 0xfe, 0x41])]), 'x');
    r = await plan(f.snap, f.manifest);
    assert.equal(!r.ok && r.rejection.code, 'non-utf8-path');

    f = await fresh();
    const other = await AttributeEvaluator.create(fx.git, s.layout, { ...s.d, autocrlf: 'true' }, fx.root);
    try {
      r = await planCommit({ git: fx.git, repo: s.layout, base: f.manifest, snapshotDir: f.snap, attributes: other, exclude });
      assert.equal(!r.ok && r.rejection.code, 'description-mismatch');
    } finally {
      other.dispose();
    }
  } finally {
    s.ev.dispose();
  }
});

test('commit-generation admission sees every write before anything is written (6.5)', async () => {
  const s = await setup({ '.gitattributes': '*.txt eol=crlf\n', 'a.txt': 'a\n' });
  try {
    const snap = dir('snap');
    const manifest = await materializeSnapshot({ git: fx.git, repo: s.layout, commit: s.base, attributes: s.ev, dest: snap });
    mkdirSync(join(snap, 'd1', 'd2'), { recursive: true });
    writeFileSync(join(snap, 'd1', 'd2', 'n.txt'), 'x\r\ny\r\n'); // converted: staged in a temp file
    writeFileSync(join(snap, 'raw.bin'), Buffer.from([1, 2, 3])); // identity: read from the snapshot directly
    let seen: { newObjects: readonly { type: string; size: number }[]; tempFileSizes: readonly number[] } | null = null;
    const r = await canonicalize({
      git: fx.git,
      repo: s.layout,
      base: manifest,
      snapshotDir: snap,
      attributes: s.ev,
      candidateDir: dir('candidate'),
      tempDir: fx.root,
      message: 'm\n',
      author: ident,
      committer: ident,
      admit: (sizes) => {
        seen = sizes;
        return false;
      },
    });
    assert.equal(r.kind, 'not-admitted');
    assert.ok(seen !== null);
    const sizes = seen as { newObjects: readonly { type: string; size: number }[]; tempFileSizes: readonly number[] };
    // Two blobs, three new trees (root, d1, d1/d2), one commit.
    assert.deepEqual(sizes.newObjects.map((o) => o.type), ['blob', 'blob', 'tree', 'tree', 'tree', 'commit']);
    assert.deepEqual(sizes.tempFileSizes, [4]);
    const blob = gitObjectId('sha1', 'blob', Buffer.from('x\ny\n'));
    const info = await batchCheck(fx.git, s.layout, [blob]);
    assert.equal(info.get(blob), null, 'nothing was written');
  } finally {
    s.ev.dispose();
  }
});

test('LFS objects must be local before dispatch: the check lists what is missing and says to run git lfs fetch (7.1 v34)', async () => {
  const s = await setup({ '.gitattributes': '*.bin filter=lfs diff=lfs merge=lfs -text\n', 'readme': 'r\n' });
  try {
    const present = randomBytes(2000);
    const absent = randomBytes(3000);
    const tmpObj = join(fx.root, `obj-${counter++}`);
    writeFileSync(tmpObj, present);
    storeLfsObject(s.layout.commonDir, tmpObj, lfsPointerFor(present));
    const commit = rawCommit(
      fx,
      s.repo,
      {
        '.gitattributes': '*.bin filter=lfs diff=lfs merge=lfs -text\n',
        'here.bin': encodeLfsPointer(lfsPointerFor(present)),
        'gone.bin': encodeLfsPointer(lfsPointerFor(absent)),
        'not-a-pointer.bin': randomBytes(5000),
        'empty.bin': '',
      },
      s.base,
      'lfs',
    );
    const r = await checkLfsObjectsPresent({ git: fx.git, repo: s.layout, commit, attributes: s.ev });
    assert.equal(r.ok, false);
    assert.deepEqual(r.missing, [{ path: 'gone.bin', pointer: lfsPointerFor(absent), problem: 'missing' }]);
    assert.match(r.hint ?? '', /git lfs fetch/);
    const excluded = await checkLfsObjectsPresent({ git: fx.git, repo: s.layout, commit, attributes: s.ev, exclude: (p) => p === 'gone.bin' });
    assert.deepEqual(excluded, { ok: true, missing: [], hint: null });
  } finally {
    s.ev.dispose();
  }
});

// ---------------------------------------------------------------- review r1 #6: LFS objects are verified by content

test('review r1 #6: a same-length object with other bytes under the pointer\'s oid is refused, nothing is materialized from it', async () => {
  const s = await setup({ '.gitattributes': '*.bin filter=lfs diff=lfs merge=lfs -text\n', 'readme': 'r\n' });
  try {
    const good = Buffer.from('GOOD');
    const evil = Buffer.from('EVIL'); // same length
    const pointer = lfsPointerFor(good);
    const stored = lfsObjectPath(s.layout.commonDir, pointer.oid);
    mkdirSync(join(stored, '..'), { recursive: true });
    writeFileSync(stored, evil);
    const commit = rawCommit(fx, s.repo, { '.gitattributes': '*.bin filter=lfs diff=lfs merge=lfs -text\n', 'data.bin': encodeLfsPointer(pointer) }, s.base, 'lfs');
    const dest = dir('snap-evil');
    const r = await materializeSnapshot({ git: fx.git, repo: s.layout, commit, attributes: s.ev, dest }).catch((e: unknown) => e);
    assert.ok(r instanceof RepresentationError && r.code === 'lfs-object-corrupt', String(r));
    assert.equal(existsSync(join(dest, 'data.bin')), false, 'no file was materialized from the wrong bytes');
    assert.deepEqual(readdirSync(dest).filter((n) => n.includes('mp-lfs-')), [], 'no temporary copy is left');
    // Manifest-only materialization (no destination) refuses it the same way: the manifest never declares bytes it did not verify.
    const m = await materializeSnapshot({ git: fx.git, repo: s.layout, commit, attributes: s.ev }).catch((e: unknown) => e);
    assert.ok(m instanceof RepresentationError && m.code === 'lfs-object-corrupt', String(m));
    // The dispatch check sees it too (content, not just size), and says what to run.
    const presence = await checkLfsObjectsPresent({ git: fx.git, repo: s.layout, commit, attributes: s.ev });
    assert.equal(presence.ok, false);
    assert.deepEqual(presence.missing, [{ path: 'data.bin', pointer, problem: 'corrupt' }]);
    assert.match(presence.hint ?? '', /git lfs fsck/);
    // Storing the real content repairs the store: the existing object is verified, not trusted by its size.
    const src = join(fx.root, `good-${counter++}`);
    writeFileSync(src, good);
    storeLfsObject(s.layout.commonDir, src, pointer);
    assert.ok(readFileSync(stored).equals(good), 'the corrupt object was replaced by the verified copy');
    const ok = await materializeSnapshot({ git: fx.git, repo: s.layout, commit, attributes: s.ev, dest: dir('snap-good') });
    assert.equal(ok.entries.find((e) => e.path === 'data.bin')?.sha256, pointer.oid);
  } finally {
    s.ev.dispose();
  }
});

test('review r1 #6: a link or a FIFO where an LFS object should be is never followed or waited on', async () => {
  const s = await setup({ '.gitattributes': '*.bin filter=lfs diff=lfs merge=lfs -text\n', 'readme': 'r\n' });
  try {
    const content = randomBytes(2048);
    const pointer = lfsPointerFor(content);
    const stored = lfsObjectPath(s.layout.commonDir, pointer.oid);
    mkdirSync(join(stored, '..'), { recursive: true });
    // A symlink to a file with exactly the right bytes: still refused (the store holds objects, not links).
    const elsewhere = join(fx.root, `elsewhere-${counter++}`);
    writeFileSync(elsewhere, content);
    symlinkSync(elsewhere, stored);
    const commit = rawCommit(fx, s.repo, { '.gitattributes': '*.bin filter=lfs diff=lfs merge=lfs -text\n', 'x.bin': encodeLfsPointer(pointer) }, s.base, 'lfs');
    const dest = dir('snap-link');
    const r = await materializeSnapshot({ git: fx.git, repo: s.layout, commit, attributes: s.ev, dest }).catch((e: unknown) => e);
    assert.ok(r instanceof RepresentationError && r.code === 'lfs-object-corrupt', String(r));
    assert.equal(existsSync(join(dest, 'x.bin')), false);
    assert.equal((await checkLfsObjectsPresent({ git: fx.git, repo: s.layout, commit, attributes: s.ev })).missing[0]?.problem, 'corrupt');
    // A FIFO: refused at once instead of blocking the read.
    unlinkSync(stored);
    execFileSync('mkfifo', [stored]);
    const started = Date.now();
    const f = await materializeSnapshot({ git: fx.git, repo: s.layout, commit, attributes: s.ev, dest: dir('snap-fifo') }).catch((e: unknown) => e);
    assert.ok(f instanceof RepresentationError && f.code === 'lfs-object-corrupt', String(f));
    assert.ok(Date.now() - started < 5_000, 'did not wait for a writer on the FIFO');
  } finally {
    s.ev.dispose();
  }
});

// ---------------------------------------------------------------- v49: a missing git object is typed, never fetched

test('v49 (7.1): a snapshot whose blob is not in the repository: MissingObjectsError with the object and its path; the dispatch check holds the task (WI-13)', async () => {
  const s = await setup({ 'a.txt': 'a\n', 'd/b.txt': 'b\n' });
  try {
    const blob = fx.raw(['rev-parse', `${s.base}:d/b.txt`], s.repo);
    rmSync(join(s.layout.commonDir, 'objects', blob.slice(0, 2), blob.slice(2)));
    const dest = dir('snap-missing');
    const r = await materializeSnapshot({ git: fx.git, repo: s.layout, commit: s.base, attributes: s.ev, dest }).catch((e: unknown) => e);
    assert.ok(r instanceof MissingObjectsError, String(r));
    assert.equal(r.code, 'object-missing');
    assert.deepEqual(r.objects, [blob]);
    assert.deepEqual(r.paths, ['d/b.txt']);
    assert.deepEqual(readdirSync(dest), [], 'nothing was materialized');
    const presence = await checkLfsObjectsPresent({ git: fx.git, repo: s.layout, commit: s.base as never, attributes: s.ev });
    assert.equal(presence.ok, false);
    assert.deepEqual(presence.missingObjects, [blob]);
    assert.match(presence.hint ?? '', /never fetches/);
  } finally {
    s.ev.dispose();
  }
});

test('v50 (7.1): a missing tree or commit holds the task the same way (WI-13), never fetched', async () => {
  const s = await setup({ 'a.txt': 'a\n', 'd/b.txt': 'b\n' });
  try {
    const sub = fx.raw(['rev-parse', `${s.base}:d`], s.repo);
    rmSync(join(s.layout.commonDir, 'objects', sub.slice(0, 2), sub.slice(2)));
    const r = await materializeSnapshot({ git: fx.git, repo: s.layout, commit: s.base, attributes: s.ev, dest: dir('snap-no-tree') }).catch((e: unknown) => e);
    assert.ok(r instanceof MissingObjectsError, String(r));
    assert.ok(r.objects.includes(sub));
    const p = await checkLfsObjectsPresent({ git: fx.git, repo: s.layout, commit: s.base as never, attributes: s.ev });
    assert.equal(p.ok, false);
    assert.ok(p.missingObjects?.includes(sub));
    // A commit that is not there at all.
    const ghost = 'e'.repeat(40);
    const g = await materializeSnapshot({ git: fx.git, repo: s.layout, commit: ghost, attributes: s.ev }).catch((e: unknown) => e);
    assert.ok(g instanceof MissingObjectsError, String(g));
    assert.deepEqual(g.objects, [ghost]);
  } finally {
    s.ev.dispose();
  }
});
