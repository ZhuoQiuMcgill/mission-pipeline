// The repository of a run checkout (design 4.1 §5.3, Appendix G; src/git/checkoutRepository.ts):
// how it reads files under the transform description they were materialized with, what it takes
// from the project's configuration, that `mp` itself runs no configured content filter while it
// builds the index, and that a shallow clone, a partial clone and a SHA-256 repository behave as
// in the project (the history ends where it ends; a missing object is never fetched).

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { attachCheckoutRepository } from '../src/git/checkoutRepository.ts';
import { discoverRepo, gitOid } from '../src/git/objects.ts';
import { PlainGit } from '../src/git/plainGit.ts';
import { readTransformDescription } from '../src/git/representation.ts';
import { checkoutCommit, removeCheckout, runCheckoutDir, type GitContext } from '../src/git/workspace.ts';
import { initMemory, openMemory, type Memory } from '../src/memory/index.ts';
import { fixture, sh, write } from './git41-fixtures.ts';
import { tempDir } from './memory-fixtures.ts';

/** git in a checkout, as a declared command runs it (the test process's environment). */
function inCheckout(dir: string, ...args: string[]): { readonly code: number | null; readonly out: string } {
  const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
  return { code: r.status, out: (r.stdout + r.stderr).trim() };
}

function ok(dir: string, ...args: string[]): string {
  const r = inCheckout(dir, ...args);
  assert.equal(r.code, 0, `git ${args.join(' ')}: ${r.out}`);
  return r.out;
}

/** git in `dir` finds the checkout's own repository, not the enclosing project's. */
function assertOwnRepository(dir: string): void {
  assert.equal(realpathSync(ok(dir, 'rev-parse', '--show-toplevel')), realpathSync(dir), 'the checkout is the top of its own repository');
  assert.equal(realpathSync(ok(dir, 'rev-parse', '--absolute-git-dir')), join(realpathSync(dir), '.git'));
}

/** A project folder whose repository is a clone of `origin` (`args`: clone options), with its memory. */
function cloneProject(origin: string, args: readonly string[]): { readonly dir: string; readonly ctx: GitContext; readonly m: Memory; cleanup(): void } {
  const base = tempDir('mp-clone-');
  const dir = join(base, 'project');
  execFileSync('git', ['clone', '-q', ...args, pathToFileURL(origin).href, dir], { stdio: 'ignore' });
  const git = PlainGit.create();
  initMemory(dir, { git: git.runner() });
  const m = openMemory(dir, { git: git.runner() });
  return {
    dir,
    ctx: { memory: m, git },
    m,
    cleanup() {
      try {
        m.close();
      } finally {
        rmSync(base, { recursive: true, force: true });
      }
    },
  };
}

test('the checkout reads its files under the bound transform description: line endings, info attributes; none of the project’s other settings', async () => {
  const f = fixture({ files: { '.gitattributes': '*.txt text\n', 'notes.txt': 'one\ntwo\n', 'app.cfg': 'k=v\n' } });
  try {
    f.git('config', 'core.autocrlf', 'true');
    f.git('config', 'remote.origin.url', 'https://example.invalid/project.git');
    f.git('config', 'user.name', 'Someone Local');
    mkdirSync(join(f.dir, '.git', 'info'), { recursive: true });
    writeFileSync(join(f.dir, '.git', 'info', 'attributes'), '*.cfg text eol=crlf\n');
    const dir = runCheckoutDir(f.m.paths, 'eol-1');
    const co = await checkoutCommit(f.ctx, { commit: f.base, dir, repository: true });
    assert.equal(co.commit, f.base);
    assertOwnRepository(dir);
    assert.equal(readFileSync(join(dir, 'notes.txt'), 'utf8'), 'one\r\ntwo\r\n', 'materialized with CRLF (core.autocrlf=true)');
    assert.equal(readFileSync(join(dir, 'app.cfg'), 'utf8'), 'k=v\r\n', 'and by the info attributes');
    assert.equal(ok(dir, 'config', 'core.autocrlf'), 'true');
    assert.equal(ok(dir, 'check-attr', 'eol', '--', 'app.cfg'), 'app.cfg: eol: crlf');
    assert.equal(ok(dir, 'config', 'core.attributesFile'), join(dir, '.git', 'info', 'global-attributes'));
    assert.equal(ok(dir, 'status', '--porcelain', '--untracked-files=all'), '', 'git converts the CRLF files back to their blobs: clean');
    assert.equal(ok(dir, 'rev-parse', 'HEAD'), f.base);
    // nothing else of the project's configuration: no remote, no identity of its own
    assert.equal(ok(dir, 'remote'), '');
    assert.notEqual(inCheckout(dir, 'config', '--local', 'user.name').code, 0);
    assert.equal(inCheckout(dir, 'config', '--local', 'remote.origin.url').code, 1);
    assert.deepEqual(removeCheckout(f.ctx, dir), { removed: true });
    assert.ok(!existsSync(dir));
  } finally {
    f.cleanup();
  }
});

test('a blob its text attribute would normalize reads as modified: git’s own judgement of the checkout', async () => {
  const f = fixture({ files: { 'win.txt': 'crlf\r\nline\r\n', 'unix.txt': 'lf\n' } });
  try {
    write(f.dir, '.gitattributes', '*.txt text\n');
    f.git('add', '.gitattributes');
    f.git('commit', '-q', '-m', 'attributes');
    const commit = f.git('rev-parse', 'HEAD');
    const dir = runCheckoutDir(f.m.paths, 'renorm-1');
    await checkoutCommit(f.ctx, { commit, dir, repository: true });
    assertOwnRepository(dir);
    assert.equal(readFileSync(join(dir, 'win.txt'), 'utf8'), 'crlf\r\nline\r\n', 'the bytes of the blob (text, LF on this platform: nothing to convert)');
    assert.equal(ok(dir, 'status', '--porcelain'), 'M win.txt', '`git add` would store it with LF: modified');
  } finally {
    f.cleanup();
  }
});

test('mp runs no configured content filter while it builds the index; git runs it when a command asks', async () => {
  const f = fixture({ files: { '.gitattributes': '*.dat filter=probe\n', 'blob.dat': 'raw\n' } });
  const saved = process.env['GIT_CONFIG_GLOBAL'];
  try {
    const where = tempDir('mp-filter-');
    const counter = join(where, 'filter-runs.txt');
    const filter = join(where, 'filter.cjs');
    writeFileSync(filter, `require('node:fs').appendFileSync(${JSON.stringify(counter)}, process.argv[2] + '\\n');\nprocess.stdin.pipe(process.stdout);\n`);
    const global = join(where, 'gitconfig');
    writeFileSync(global, `[filter "probe"]\n\tclean = node ${filter.replace(/\\/g, '/')} clean\n\tsmudge = node ${filter.replace(/\\/g, '/')} smudge\n\trequired = true\n`);
    process.env['GIT_CONFIG_GLOBAL'] = global;
    const runs = () => (existsSync(counter) ? readFileSync(counter, 'utf8').split('\n').filter((x) => x !== '') : []);
    const dir = runCheckoutDir(f.m.paths, 'filter-1');
    const co = await checkoutCommit(f.ctx, { commit: f.base, dir, repository: true });
    assert.deepEqual(co.unsupported.map((u) => u.path), ['blob.dat'], 'a filter mp does not implement: written raw');
    assertOwnRepository(dir);
    assert.deepEqual(runs(), [], 'building the index ran no filter');
    // git may judge a file written in the same timestamp tick as the index again by content (racy
    // git): then with the user's filter, which passes the raw bytes through
    assert.equal(ok(dir, 'status', '--porcelain'), '', 'the raw file is its blob: clean');
    writeFileSync(join(dir, 'blob.dat'), 'changed\n');
    assert.equal(ok(dir, 'status', '--porcelain'), 'M blob.dat');
    assert.ok(runs().includes('clean'), 'the filter is configured for the checkout: git runs it when a command asks');
  } finally {
    if (saved === undefined) delete process.env['GIT_CONFIG_GLOBAL'];
    else process.env['GIT_CONFIG_GLOBAL'] = saved;
    f.cleanup();
  }
});

test('a shallow clone: the history ends where it ends in the project', async () => {
  const origin = fixture({ files: { 'a.txt': 'a\n' } });
  write(origin.dir, 'b.txt', 'b\n');
  origin.git('add', '-A');
  origin.git('commit', '-q', '-m', 'second');
  const p = cloneProject(origin.dir, ['--depth', '1']);
  try {
    const head = sh(p.dir, 'rev-parse', 'HEAD');
    assert.equal(sh(p.dir, 'rev-parse', '--is-shallow-repository'), 'true');
    const dir = runCheckoutDir(p.m.paths, 'shallow-1');
    await checkoutCommit(p.ctx, { commit: head, dir, repository: true });
    assertOwnRepository(dir);
    assert.equal(ok(dir, 'rev-parse', '--is-shallow-repository'), 'true');
    assert.equal(ok(dir, 'log', '--format=%H'), head, 'one commit, as in the project; no error at the boundary');
    assert.equal(ok(dir, 'status', '--porcelain'), '');
  } finally {
    p.cleanup();
    origin.cleanup();
  }
});

test('a partial clone: an object the project does not have is missing in the checkout too, and never fetched', async () => {
  const origin = fixture();
  origin.git('config', 'uploadpack.allowFilter', 'true');
  for (const v of ['2', '3']) {
    write(origin.dir, 'file.txt', `version ${v}\n`);
    origin.git('commit', '-q', '-am', `v${v}`);
  }
  const p = cloneProject(origin.dir, ['--no-local', '--filter=blob:none']);
  try {
    const head = sh(p.dir, 'rev-parse', 'HEAD');
    const objects = sh(p.dir, 'count-objects', '-v');
    const dir = runCheckoutDir(p.m.paths, 'partial-1');
    await checkoutCommit(p.ctx, { commit: head, dir, repository: true });
    assertOwnRepository(dir);
    assert.equal(ok(dir, 'status', '--porcelain'), '');
    assert.equal(ok(dir, 'log', '--format=%H').split('\n').length, 3, 'the commits are local');
    const diff = inCheckout(dir, 'diff', 'HEAD~2', 'HEAD');
    assert.notEqual(diff.code, 0, 'the first version of file.txt was never fetched');
    assert.match(diff.out, /unable to read|bad object|missing/i);
    assert.equal(sh(p.dir, 'count-objects', '-v'), objects, 'nothing was fetched into the project');
  } finally {
    p.cleanup();
    origin.cleanup();
  }
});

test('a SHA-256 repository: the checkout’s repository has its object format', async () => {
  const base = tempDir('mp-sha256-');
  const dir = join(base, 'project');
  mkdirSync(dir);
  sh(dir, 'init', '-q', '-b', 'main', '--object-format=sha256');
  write(dir, 'a.txt', 'a\n');
  sh(dir, 'add', '-A');
  sh(dir, 'commit', '-q', '-m', 'first');
  const git = PlainGit.create();
  initMemory(dir, { git: git.runner() });
  const m = openMemory(dir, { git: git.runner() });
  try {
    const head = sh(dir, 'rev-parse', 'HEAD');
    const co = runCheckoutDir(m.paths, 'sha256-1');
    await checkoutCommit({ memory: m, git }, { commit: head, dir: co, repository: true });
    assertOwnRepository(co);
    assert.equal(ok(co, 'rev-parse', '--show-object-format'), 'sha256');
    assert.equal(ok(co, 'rev-parse', 'HEAD'), head);
    assert.equal(ok(co, 'status', '--porcelain'), '');
  } finally {
    m.close();
    rmSync(base, { recursive: true, force: true });
  }
});

test('the configuration holds a checkout path with quotes, backslashes and spaces', { skip: process.platform === 'win32' ? 'such names are not allowed on Windows' : false }, async () => {
  const f = fixture();
  try {
    const dir = join(tempDir('mp-quote-'), 'a "quoted" \\ dir ü');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'file.txt'), 'hello\n');
    const repo = await discoverRepo(f.ctx.git, f.dir);
    const description = await readTransformDescription(f.ctx.git, repo, f.dir);
    await attachCheckoutRepository(f.ctx.git, repo, { dir, commit: gitOid(f.base), description });
    assertOwnRepository(dir);
    assert.equal(ok(dir, 'config', 'core.attributesFile'), join(dir, '.git', 'info', 'global-attributes'));
    assert.equal(ok(dir, 'rev-parse', 'HEAD'), f.base);
    assert.equal(ok(dir, 'status', '--porcelain'), '');
    await assert.rejects(attachCheckoutRepository(f.ctx.git, repo, { dir, commit: gitOid(f.base), description }), /already exists/);
  } finally {
    f.cleanup();
  }
});
