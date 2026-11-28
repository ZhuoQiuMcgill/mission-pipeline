// 4.4.1: the Windows default, end to end. Git for Windows sets core.autocrlf=true for every
// repository; here the fixture repository says so in its own configuration, so these tests run the
// same on every system. Its worktrees hold CRLF and its blobs LF. Through the engine (a dispatch
// worktree, the candidate built from a seat's edits, a stacked candidate, a run's checkout, a
// landing) every worktree the engine makes shows CRLF, every blob it stores is LF, nothing reads as
// modified that was not edited, and the trees are the ones an LF system makes from the same edits.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { land } from '../src/git/land.ts';
import { discoverRepo } from '../src/git/objects.ts';
import { readTransformDescription, transformDescriptionHash } from '../src/git/representation.ts';
import { checkoutCommit, collectCandidate, ensureWorkspace, removeCheckout, runCheckoutDir } from '../src/git/workspace.ts';
import { commitOn, fixture, IDENT, M, recordedDelivery, sh, words, write, type Fixture } from './git41-fixtures.ts';

const FILES: Readonly<Record<string, string>> = { 'src/a.txt': 'a1\na2\n', 'src/b.txt': 'b1\n', 'docs/readme.md': '# r\n' };
const crlf = (s: string): string => s.replace(/\n/g, '\r\n');
const read = (root: string, rel: string): string => readFileSync(join(root, ...rel.split('/')), 'utf8');
const blob = (f: Fixture, commit: string, path: string): string => execFileSync('git', ['cat-file', 'blob', `${commit}:${path}`], { cwd: f.dir, encoding: 'utf8' });
const treeOf = (f: Fixture, commit: string): string => f.git('rev-parse', `${commit}^{tree}`);

function collect(f: Fixture, dispatch: string, base: string) {
  return collectCandidate(f.ctx, { dispatch, base, writePaths: ['src/**'], message: `candidate of ${dispatch}\n`, author: IDENT, committer: IDENT });
}

test('autocrlf=true: a dispatch worktree holds CRLF; the candidate of CRLF edits stores LF, names only the edited files, and is the commit an LF system makes', async () => {
  const f = fixture({ files: FILES, autocrlf: true });
  try {
    // the project as Git for Windows leaves it
    assert.equal(read(f.dir, 'src/a.txt'), crlf(FILES['src/a.txt']!));
    assert.equal(f.git('status', '--porcelain'), '');
    assert.equal(blob(f, f.base, 'src/a.txt'), FILES['src/a.txt']);
    const w = ensureWorkspace(f.ctx, { dispatch: 'D-1', base: f.base }).path;
    for (const [p, t] of Object.entries(FILES)) assert.equal(read(w, p), crlf(t), `${p} in the dispatch worktree`);
    assert.equal(sh(w, 'status', '--porcelain'), '', 'a fresh dispatch worktree reads as unmodified');
    // the seat edits as an editor on Windows writes: CRLF
    write(w, 'src/a.txt', crlf('a1\nA2\n'));
    write(w, 'src/new.txt', crlf('n1\nn2\n'));
    const c = await collect(f, 'D-1', f.base);
    assert.equal(c.kind, 'candidate', JSON.stringify(c));
    if (c.kind !== 'candidate') return;
    assert.deepEqual([c.added, c.modified, c.deleted], [['src/new.txt'], ['src/a.txt'], []], 'only what the seat edited');
    assert.equal(blob(f, c.commit, 'src/a.txt'), 'a1\nA2\n');
    assert.equal(blob(f, c.commit, 'src/new.txt'), 'n1\nn2\n');
    assert.equal(f.git('rev-parse', `${c.commit}:src/b.txt`), f.git('rev-parse', `${f.base}:src/b.txt`), 'an unedited file keeps its blob');
    assert.equal(treeOf(f, c.commit), treeOf(f, commitOn(f.dir, f.base, { 'src/a.txt': 'a1\nA2\n', 'src/new.txt': 'n1\nn2\n' })), 'the tree an LF system makes');
    // collected again, unchanged: the same commit; the worktree still reads only the edits as changed
    const again = await collect(f, 'D-1', f.base);
    assert.equal(again.kind === 'candidate' && again.commit, c.commit, 'the product is stable');
    assert.deepEqual(sh(w, 'status', '--porcelain', '--untracked-files=all').split('\n').map((l) => l.trim()).sort(), ['?? src/new.txt', 'M src/a.txt']);
    // the worktree and the project read one transform description
    const repo = await discoverRepo(f.ctx.git, f.dir);
    const d = await readTransformDescription(f.ctx.git, repo, f.dir);
    assert.equal(d.autocrlf, 'true');
    assert.equal(transformDescriptionHash(await readTransformDescription(f.ctx.git, repo, w)), transformDescriptionHash(d));
  } finally {
    f.cleanup();
  }
});

test('autocrlf=true: a stacked candidate, a run checkout and a landing keep CRLF in the worktrees and LF in the blobs; nothing unedited reads as modified', async () => {
  const f = fixture({ files: FILES, autocrlf: true });
  try {
    const w1 = ensureWorkspace(f.ctx, { dispatch: 'D-1', base: f.base }).path;
    write(w1, 'src/a.txt', crlf('a1\nA2\n'));
    const c1 = await collect(f, 'D-1', f.base);
    assert.equal(c1.kind, 'candidate', JSON.stringify(c1));
    if (c1.kind !== 'candidate') return;
    // a dependent's work starts from the first candidate (a stacked product)
    const w2 = ensureWorkspace(f.ctx, { dispatch: 'D-2', base: c1.commit }).path;
    assert.equal(read(w2, 'src/a.txt'), crlf('a1\nA2\n'));
    assert.equal(sh(w2, 'status', '--porcelain'), '');
    write(w2, 'src/b.txt', crlf('b1\nB2\n'));
    const c2 = await collect(f, 'D-2', c1.commit);
    assert.equal(c2.kind, 'candidate', JSON.stringify(c2));
    if (c2.kind !== 'candidate') return;
    assert.deepEqual([c2.added, c2.modified, c2.deleted], [[], ['src/b.txt'], []], 'only its own edit, against the candidate it rests on');
    assert.equal(f.git('rev-parse', `${c2.commit}^`), c1.commit);
    assert.deepEqual([blob(f, c2.commit, 'src/a.txt'), blob(f, c2.commit, 'src/b.txt')], ['a1\nA2\n', 'b1\nB2\n']);
    assert.equal(treeOf(f, c2.commit), treeOf(f, commitOn(f.dir, f.base, { 'src/a.txt': 'a1\nA2\n', 'src/b.txt': 'b1\nB2\n' })));
    // a clean checkout for a run: CRLF files under the bound description; git there finds nothing modified
    const dir = runCheckoutDir(f.m.paths, 'run-crlf');
    await checkoutCommit(f.ctx, { commit: c2.commit, dir, repository: true });
    for (const [p, t] of Object.entries({ ...FILES, 'src/a.txt': 'a1\nA2\n', 'src/b.txt': 'b1\nB2\n' })) assert.equal(read(dir, p), crlf(t), `${p} in the run checkout`);
    assert.equal(sh(dir, 'status', '--porcelain', '--untracked-files=all'), '');
    assert.equal(sh(dir, 'rev-parse', 'HEAD'), c2.commit);
    assert.deepEqual(removeCheckout(f.ctx, dir), { removed: true });
    // the landing: main fast-forwards in the project's own worktree, which then holds CRLF and is consistent
    recordedDelivery(f, 'd1', c2.commit, f.base, 'main');
    const r = await land(f.ctx, { mission: M, delivery: 'd1', words: words(f.m) });
    assert.equal(r.kind, 'landed', JSON.stringify(r));
    if (r.kind !== 'landed') return;
    assert.equal(r.via, 'fast-forward');
    assert.equal(r.worktree?.relation, 'consistent', JSON.stringify(r.worktree));
    assert.equal(read(f.dir, 'src/b.txt'), crlf('b1\nB2\n'));
    assert.equal(f.git('status', '--porcelain'), '', 'the landed worktree reads as unmodified');
  } finally {
    f.cleanup();
  }
});
