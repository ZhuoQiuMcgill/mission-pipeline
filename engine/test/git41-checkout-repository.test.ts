// The repository of a run checkout (design 4.1 §5.3, Appendix G; src/git/checkoutRepository.ts):
// how it reads files under the transform description they were materialized with, what it takes
// from the project's configuration, that `mp` itself runs no configured content filter while it
// builds the index, and that a shallow clone, a partial clone and a SHA-256 repository behave as
// in the project (the history ends where it ends; a missing object is never fetched).

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { lfsObjectPath, lfsClean } from '../src/git/lfs.ts';
import { attachCheckoutRepository, lfsFilterProcess } from '../src/git/checkoutRepository.ts';
import { discoverRepo, gitOid } from '../src/git/objects.ts';
import { PlainGit, shellQuote } from '../src/git/plainGit.ts';
import { AttributeEvaluator, readTransformDescription } from '../src/git/representation.ts';
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

test('attribute repository init ignores a global refusing reference-transaction hook', { skip: process.platform === 'win32' }, async () => {
  const f = fixture();
  const saved = process.env['GIT_CONFIG_GLOBAL'];
  const scratch = tempDir('mp-attr-refuse-');
  try {
    const repo = await discoverRepo(f.ctx.git, f.dir);
    const description = await readTransformDescription(f.ctx.git, repo, f.dir);
    const hooks = join(scratch, 'hooks');
    const marker = join(scratch, 'hook-called');
    mkdirSync(hooks);
    const hook = join(hooks, 'reference-transaction');
    writeFileSync(hook, `#!/bin/sh\nprintf '%s\\n' "$1" >> '${marker}'\nexit 1\n`);
    chmodSync(hook, 0o755);
    const global = join(scratch, 'gitconfig');
    writeFileSync(global, `[core]\n\thooksPath = ${JSON.stringify(hooks)}\n`);
    process.env['GIT_CONFIG_GLOBAL'] = global;
    const attributes = await AttributeEvaluator.create(f.ctx.git, repo, description, scratch);
    try {
      assert.equal(existsSync(marker), false, 'bare init ran no hook');
      assert.notEqual(inCheckout(attributes.dir, '--git-dir', join(attributes.dir, 'attr.git'), 'config', '--local', 'core.hooksPath').code, 0, 'the shield is command-local');
      const control = inCheckout(f.dir, 'update-ref', 'refs/heads/refusing-hook-control', f.base);
      assert.notEqual(control.code, 0, 'the refusing hook is active for normal git commands');
      assert.ok(existsSync(marker));
    } finally { attributes.dispose(); }
  } finally {
    if (saved === undefined) delete process.env['GIT_CONFIG_GLOBAL'];
    else process.env['GIT_CONFIG_GLOBAL'] = saved;
    f.cleanup();
    rmSync(scratch, { recursive: true, force: true });
  }
});

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
    writeFileSync(join(dir, 'blob.dat'), 'RAW\n');
    assert.notEqual(ok(dir, 'hash-object', '--path=blob.dat', 'blob.dat'), ok(dir, 'rev-parse', 'HEAD:blob.dat'), 'force clean conversion of the changed content');
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


test('global hooks do not fire during setup, but declared git commands inherit them', { skip: process.platform === 'win32' }, async () => {
  const f = fixture();
  const saved = process.env['GIT_CONFIG_GLOBAL'];
  try {
    // checkoutCommit replaces its destination: keep the global config and hooks elsewhere.
    const hooks = join(f.m.paths.tmp, 'global-hooks');
    mkdirSync(hooks, { recursive: true });
    const counter = join(hooks, 'calls');
    for (const name of ['reference-transaction', 'post-index-change']) {
      const hook = join(hooks, name);
      writeFileSync(hook, `#!/bin/sh\nprintf '%s\\n' '${name}' >> ${shellQuote(counter)}\n`);
      chmodSync(hook, 0o755);
    }
    const cfg = join(hooks, 'global-config');
    writeFileSync(cfg, `[core]\n hooksPath = "${hooks}"\n`);
    process.env['GIT_CONFIG_GLOBAL'] = cfg;
    const dir = runCheckoutDir(f.m.paths, 'hooks');
    await checkoutCommit(f.ctx, { commit: f.base, dir, repository: true });
    for (const name of ['reference-transaction', 'post-index-change']) assert.ok(existsSync(join(hooks, name)), 'setup preserves the global hook files');
    assert.equal(existsSync(counter), false, 'mp setup runs no hook');
    assert.equal(inCheckout(dir, 'config', '--local', '--get', 'core.hooksPath').code, 1, 'override is never persisted');
    assert.equal(ok(dir, 'config', '--get', 'core.hooksPath'), hooks, 'declared commands inherit the global setting');
    ok(dir, 'update-ref', 'refs/probe', f.base);
    assert.match(readFileSync(counter, 'utf8'), /reference-transaction/, 'git in a declared command uses the global hooks');
    writeFileSync(join(dir, 'new.txt'), 'new\n');
    ok(dir, 'add', 'new.txt');
    assert.match(readFileSync(counter, 'utf8'), /post-index-change/);
  } finally {
    if (saved === undefined) delete process.env['GIT_CONFIG_GLOBAL']; else process.env['GIT_CONFIG_GLOBAL'] = saved;
    f.cleanup();
  }
});

test('a rejecting global reference hook cannot interrupt checkout preparation, including internal LFS conversion', { skip: process.platform === 'win32' }, async () => {
  const content = Buffer.from('LFS payload\n');
  const pointer = lfsClean(content);
  const f = fixture({ files: { '.gitattributes': 'blob.dat filter=lfs -text\n', 'blob.dat': pointer.blob.toString('utf8') } });
  const saved = process.env['GIT_CONFIG_GLOBAL'];
  try {
    const object = lfsObjectPath(join(f.dir, '.git'), pointer.object!.oid);
    mkdirSync(join(object, '..'), { recursive: true });
    writeFileSync(object, content);
    const hooks = join(f.m.paths.tmp, 'rejecting-hooks');
    mkdirSync(hooks);
    const counter = join(hooks, 'calls');
    const hook = join(hooks, 'reference-transaction');
    writeFileSync(hook, `#!/bin/sh\nprintf '%s\\n' "$1" >> ${shellQuote(counter)}\nexit 1\n`);
    chmodSync(hook, 0o755);
    const cfg = join(hooks, 'global-config');
    writeFileSync(cfg, `[core]\n hooksPath = "${hooks}"\n`);
    process.env['GIT_CONFIG_GLOBAL'] = cfg;
    // Both paths initialize a scratch attribute repository; only a run attaches its own .git.
    const reading = runCheckoutDir(f.m.paths, 'hookless-reading');
    await checkoutCommit(f.ctx, { commit: f.base, dir: reading });
    assert.equal(existsSync(join(reading, '.git')), false);
    const dir = runCheckoutDir(f.m.paths, 'hookless-lfs');
    await checkoutCommit(f.ctx, { commit: f.base, dir, repository: true });
    assert.deepEqual(readFileSync(join(dir, 'blob.dat')), content);
    assert.equal(existsSync(counter), false, 'a refusing hook must never be invoked during either setup');
    assert.equal(ok(dir, 'status', '--porcelain'), '');
    assert.notEqual(inCheckout(dir, 'update-ref', 'refs/rejected', f.base).code, 0, 'declared commands still inherit the refusing hook');
    assert.match(readFileSync(counter, 'utf8'), /prepared/);
    assert.equal(inCheckout(dir, 'rev-parse', '--verify', '--quiet', 'refs/rejected').code, 1);
  } finally {
    if (saved === undefined) delete process.env['GIT_CONFIG_GLOBAL']; else process.env['GIT_CONFIG_GLOBAL'] = saved;
    f.cleanup();
  }
});

for (const scope of ['local', 'global'] as const) test(`project-${scope} LFS config: pristine content is clean through mp conversion, and changed content is modified`, async () => {
  const content = Buffer.from('LFS payload\n');
  const pointer = lfsClean(content).blob.toString('utf8');
  const f = fixture({ files: { '.gitattributes': 'blob.dat filter=lfs -text\n', 'blob.dat': pointer } });
  const saved = process.env['GIT_CONFIG_GLOBAL'];
  try {
    const oid = createHash('sha256').update(content).digest('hex');
    const object = lfsObjectPath(join(f.dir, '.git'), oid);
    mkdirSync(join(object, '..'), { recursive: true });
    writeFileSync(object, content);
    const counter = join(f.m.paths.tmp, 'project-filter-calls');
    const forbidden = `echo project-filter >> ${shellQuote(counter)}; exit 93`;
    if (scope === 'global') {
      const cfg = join(f.m.paths.tmp, 'lfs-global-config');
      writeFileSync(cfg, '');
      process.env['GIT_CONFIG_GLOBAL'] = cfg;
    }
    for (const [key, value] of [['filter.lfs.clean', forbidden], ['filter.lfs.smudge', forbidden], ['filter.lfs.process', forbidden], ['filter.lfs.required', 'true']]) f.git('config', `--${scope}`, key!, value!);
    const dir = runCheckoutDir(f.m.paths, 'lfs');
    await checkoutCommit(f.ctx, { commit: f.base, dir, repository: true });
    assert.deepEqual(readFileSync(join(dir, 'blob.dat')), content);
    assert.equal(existsSync(counter), false, 'setup runs no project LFS program');
    assert.equal(ok(dir, 'hash-object', '--path=blob.dat', 'blob.dat'), ok(dir, 'rev-parse', 'HEAD:blob.dat'), 'real Git uses the pointer conversion');
    assert.equal(ok(dir, 'diff-files', '--name-only'), '', 'index refreshed with the built-in conversion, before status runs');
    assert.equal(ok(dir, 'status', '--porcelain'), '');
    writeFileSync(join(dir, 'blob.dat'), 'LFS changed\n');
    assert.equal(ok(dir, 'status', '--porcelain'), 'M blob.dat');
    writeFileSync(join(dir, 'blob.dat'), content);
    assert.equal(ok(dir, 'status', '--porcelain'), '', 'restoring the original content is clean again');
    assert.equal(existsSync(counter), false, 'declared Git commands also use only the engine conversion');
    assert.match(ok(dir, 'config', 'filter.lfs.process'), /--lfs-filter-process/);
    assert.equal(ok(dir, 'config', 'filter.lfs.required'), 'false');
    assert.match(ok(dir, 'config', 'filter.lfs.clean'), /--lfs-clean/);
  } finally {
    if (saved === undefined) delete process.env['GIT_CONFIG_GLOBAL']; else process.env['GIT_CONFIG_GLOBAL'] = saved;
    f.cleanup();
  }
});

test('the internal LFS clean entry point uses the engine conversion for content, pointers and empty input', () => {
  const file = fileURLToPath(new URL('../src/git/checkoutRepository.ts', import.meta.url));
  const content = Buffer.from('some content\n');
  for (const input of [content, lfsClean(content).blob, Buffer.alloc(0)]) {
    const result = spawnSync(process.execPath, ['--experimental-strip-types', '--disable-warning=ExperimentalWarning', file, '--lfs-clean'], { input, timeout: 10_000 });
    assert.equal(result.status, 0, result.stderr.toString());
    assert.deepEqual(result.stdout, lfsClean(input).blob);
  }
});

test('the internal LFS filter process handles multiple clean requests, binary packets, pointers and empty input', () => {
  const list = (...packets: Buffer[]): Buffer => Buffer.concat([
    ...packets.flatMap((p) => [Buffer.from((p.length + 4).toString(16).padStart(4, '0')), p]), Buffer.from('0000'),
  ]);
  const lines = (...text: string[]): Buffer => list(...text.map((s) => Buffer.from(`${s}\n`)));
  const binary = Buffer.alloc(100_000);
  for (let i = 0; i < binary.length; ++i) binary[i] = i % 256;
  const content = [binary, lfsClean(binary).blob, Buffer.alloc(0)];
  function exchange(request: Buffer): Buffer {
    const root = tempDir('mp-lfs-protocol-');
    const input = join(root, 'input');
    const output = join(root, 'output');
    const fds: number[] = [];
    try {
      writeFileSync(input, request);
      fds.push(openSync(input, 'r'));
      fds.push(openSync(output, 'w'));
      lfsFilterProcess(fds[0]!, fds[1]!);
      return readFileSync(output);
    } finally {
      for (const fd of fds) closeSync(fd);
      rmSync(root, { recursive: true, force: true });
    }
  }
  const hello = lines('git-filter-client', 'version=2');
  const capabilities = lines('capability=clean', 'capability=smudge', 'capability=delay');
  assert.deepEqual(exchange(Buffer.concat([
      hello, capabilities,
      ...content.flatMap((data) => [lines('command=clean', 'pathname=blob.dat'), list(...[data.subarray(0, 60_000), data.subarray(60_000)].filter((p) => p.length > 0))]),
    ])), Buffer.concat([
      lines('git-filter-server', 'version=2'), lines('capability=clean'),
      ...content.flatMap((data) => [lines('status=success'), data.length === 0 ? list() : list(lfsClean(data).blob), list()]),
    ]));
  for (const [input, message] of [
    [Buffer.from('zzzz'), /packet size/],
    [Buffer.from('0002'), /packet size/],
    [Buffer.from('0008ab'), /unexpected EOF/],
    [lines('git-filter-client', 'version=1'), /unsupported.*protocol/],
    [Buffer.concat([hello, lines('capability=smudge')]), /requires clean capability/],
    [Buffer.concat([hello, capabilities, lines('command=smudge'), list()]), /unsupported.*command/],
    [Buffer.concat([hello, capabilities, lines('command=clean'), Buffer.from('0008ab')]), /unexpected EOF/],
  ] as const) {
    assert.throws(() => exchange(input), message, 'malformed input terminates the filter instead of waiting for another request');
  }
});
