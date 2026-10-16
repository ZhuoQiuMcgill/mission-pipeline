// The repository of a run checkout (design 4.1 §5.3; Appendix G).
//
// A run checkout (a verification run's `tmp/<run>/`, a rerun's, a renewal's, the run directory of a
// delivery candidate's closing checks) is materialized from the candidate's objects alone
// (representation.ts) inside the project's work tree, under `.mission-pipeline/`, which `mp init`
// excludes. Without a repository of its own, every git question a declared command asks there is
// answered by the enclosing repository, where the whole checkout is an excluded path: `git
// ls-files` lists nothing, tracked files read as untracked or ignored, `git log` and `git diff
// <base>` see the enclosing branch, and tools that honour git's ignore rules find no file. So the
// checkout gets its own `.git`, positioned exactly at the candidate:
//   - `git init` without a template: no hooks, no info/exclude, no remote, no branch;
//   - the project's objects, borrowed: `objects/info/alternates` names the project's common git
//     directory's `objects` (git follows that store's own alternates as for any alternate); the
//     project's `shallow` list is copied, so history ends where it ends in the project; there is
//     no promisor remote, so an object the project does not have locally is missing here too and
//     is never fetched (WI-13);
//   - its configuration: the bound transform description (core.autocrlf, core.eol, core.symlinks,
//     core.filemode, core.ignorecase; the description's info attributes as `info/attributes` and
//     its global attributes as `core.attributesFile`), so git converts the files on disk by the
//     rules they were materialized under; no file system monitor (no daemon outlives the
//     checkout) and no automatic gc. Nothing else of the project's own configuration is copied:
//     only the engine's built-in LFS conversion names a program; no remote or identity. Global and system
//     configuration apply, as in any repository;
//   - HEAD detached at the candidate;
//   - the index read from the candidate's tree and refreshed against the files on disk, so its
//     stat data describe the checkout and plumbing that does not refresh them (`git diff-index
//     --quiet HEAD`, `git diff-files`) finds a pristine checkout clean. `git status` of a pristine
//     checkout is empty when every file's bytes convert back to its blob, as the files of the
//     supported transforms materialized from normalized blobs do. Where they do not (a blob stored
//     with line endings its `text` attribute normalizes), git reports the path as modified: git's
//     own judgement of those bytes, the one it gives in the project's work tree once it looks at
//     the file. The refresh disables every project content filter and enables only the engine's
//     LFS pointer conversion. A file written raw (an unsupported filter) is its blob; LFS content
//     converts back with the built-in conversion, also kept in the local config. Git can judge a
//     file written in the same timestamp tick as the index again by content (racy entries).
// Nothing is written to the project's repository: no worktree registration, no ref, no
// configuration, no object. The `.git` is removed with the checkout.

import { copyFileSync, existsSync, mkdirSync, readFileSync, readSync, writeFileSync, writeSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { lfsClean } from './lfs.ts';
import { shellQuote } from './plainGit.ts';
import type { GitOid } from '../common/ids.ts';
import type { RepoLayout } from './objects.ts';
import type { GitExec, GitLocators, GitRunOptions } from './plainGit.ts';
import type { TransformDescription } from './representation.ts';

/** A value for a git configuration file, always quoted (backslash, double quote and newline escaped). */
function configValue(v: string): string {
  if (v.includes('\0')) throw new TypeError(`a configuration value cannot hold NUL: ${JSON.stringify(v)}`);
  return `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`;
}

/** Setup includes the scratch attribute repository: even `git init --bare` can run a
 * reference-transaction hook. Keep suppression local to these calls and their children. */
export function checkoutSetupGit(git: GitExec, gitDir: string): GitExec {
  const hooks = join(gitDir, 'mp-empty-hooks');
  mkdirSync(hooks, { recursive: true });
  const options = (at: GitRunOptions): GitRunOptions => ({ ...at, config: [...(at.config ?? []), ['core.hooksPath', hooks]] });
  return {
    run: (args, at) => git.run(args, options(at)),
    ok: (args, at) => git.ok(args, options(at)),
    text: (args, at) => git.text(args, options(at)),
    withLocators: (locators) => checkoutSetupGit(git.withLocators(locators), gitDir),
  };
}

/** The checkout's own configuration: the bound transform description, no file system monitor, no automatic gc. */
function checkoutConfig(d: TransformDescription, globalAttributes: string): string {
  return [
    '[core]',
    `\tautocrlf = ${d.autocrlf}`,
    // "unset" is what git itself reads for any value it does not know: the description's unset core.eol
    `\teol = ${d.eol}`,
    `\tsymlinks = ${d.symlinks}`,
    `\tfilemode = ${d.fileMode}`,
    `\tignorecase = ${d.ignoreCase}`,
    `\tattributesFile = ${configValue(globalAttributes)}`,
    '\tfsmonitor = false',
    '[filter "lfs"]',
    `\tclean = ${configValue(lfsCleanCommand())}`,
    '\tsmudge =',
    // Even an empty process setting suppresses clean in Git. Override inherited programs with
    // the engine's clean-only filter protocol instead (convert.c::apply_filter).
    `\tprocess = ${configValue(lfsCleanCommand('--lfs-filter-process'))}`,
    '\trequired = false',
    '[gc]',
    '\tauto = 0',
    '',
  ].join('\n');
}

/**
 * Configuration pairs that switch off configured content filters except the engine's LFS
 * conversion, for one git run: null when a driver's name cannot be named on a command line
 * (it holds "="), and the caller then leaves the index unrefreshed.
 */
async function filtersOff(git: GitExec, at: { readonly cwd: string; readonly locators: GitLocators }): Promise<Array<readonly [string, string]> | null> {
  const r = await git.run(['config', '-z', '--name-only', '--get-regexp', '^filter\\.'], at);
  if (r.code !== 0 && r.code !== 1) return null;
  const names = new Set<string>();
  for (const key of r.stdout.toString('utf8').split('\0')) {
    const last = key.lastIndexOf('.');
    if (!key.startsWith('filter.') || last <= 'filter.'.length) continue;
    names.add(key.slice('filter.'.length, last));
  }
  const pairs: Array<readonly [string, string]> = [];
  for (const n of [...names].sort()) {
    if (n.includes('=') || /[\0\n]/.test(n)) return null;
    pairs.push([`filter.${n}.process`, n === 'lfs' ? lfsCleanCommand('--lfs-filter-process') : ''], [`filter.${n}.clean`, n === 'lfs' ? lfsCleanCommand() : ''], [`filter.${n}.smudge`, ''], [`filter.${n}.required`, 'false']);
  }
  return pairs;
}

/**
 * Make the materialized checkout `dir` of `commit` a git repository positioned at the commit (see
 * the top of this file). `description`: the transform description the files were materialized
 * under. Writes only inside `dir/.git`; nothing in the project's repository.
 */
export async function attachCheckoutRepository(git: GitExec, repo: RepoLayout, o: { readonly dir: string; readonly commit: GitOid; readonly description: TransformDescription }): Promise<void> {
  const gitDir = join(o.dir, '.git');
  // A tree never holds .git (unsafePathReason): one here is not the candidate's.
  if (existsSync(gitDir)) throw new Error(`${gitDir} already exists: a checkout's repository is made once, in a fresh checkout`);
  // The new repository is named explicitly from here on, never discovered (6.6 v37).
  git = checkoutSetupGit(git, gitDir);
  const own = { cwd: o.dir, locators: { gitDir, workTree: o.dir } };
  await git.ok(['init', '--quiet', '--template=', `--object-format=${repo.objectFormat}`, '--', o.dir], own);
  mkdirSync(join(gitDir, 'objects', 'info'), { recursive: true });
  writeFileSync(join(gitDir, 'objects', 'info', 'alternates'), join(repo.commonDir, 'objects') + '\n');
  const shallow = join(repo.commonDir, 'shallow');
  if (existsSync(shallow)) copyFileSync(shallow, join(gitDir, 'shallow'));
  mkdirSync(join(gitDir, 'info'), { recursive: true });
  writeFileSync(join(gitDir, 'info', 'attributes'), o.description.attributes.info ?? '');
  const globalAttributes = join(gitDir, 'info', 'global-attributes');
  writeFileSync(globalAttributes, o.description.attributes.global ?? '');
  const config = join(gitDir, 'config');
  writeFileSync(config, readFileSync(config, 'utf8').replace(/\n?$/, '\n') + checkoutConfig(o.description, globalAttributes));
  await git.ok(['update-ref', '--no-deref', '-m', 'mp: a clean checkout of the candidate', 'HEAD', o.commit], own);
  await git.ok(['read-tree', o.commit], own);
  const off = await filtersOff(git, own);
  // Exit 1: some paths need an update (they are left for git to judge on demand). Any other failure
  // leaves the index as read-tree wrote it: the candidate's tree, without stat data.
  if (off !== null) await git.run(['update-index', '-q', '--refresh'], { ...own, config: off });
}

/** Internal engine entry point for Git's clean conversion. Git invokes filter commands with
 * its shell on every platform, including Git for Windows. No project program is involved. */
function lfsCleanCommand(mode: '--lfs-clean' | '--lfs-filter-process' = '--lfs-clean'): string {
  return `${shellQuote(process.execPath)} --experimental-strip-types --disable-warning=ExperimentalWarning ${shellQuote(fileURLToPath(import.meta.url))} ${mode}`;
}

/** Git filter protocol v2, clean only. Smudge, delay and project programs are never invoked. */
export function lfsFilterProcess(input: number, output: number): void {
  function readBytes(size: number, eof = false): Buffer | null {
    const bytes = Buffer.alloc(size);
    let offset = 0;
    while (offset < size) {
      const n = readSync(input, bytes, offset, size - offset, null);
      if (n === 0) {
        if (eof && offset === 0) return null;
        throw new Error('unexpected EOF in the Git LFS filter protocol');
      }
      offset += n;
    }
    return bytes;
  }
  function readList(eof = false): Buffer[] | null {
    const packets: Buffer[] = [];
    for (;;) {
      const header = readBytes(4, eof && packets.length === 0);
      if (header === null) return null;
      const hex = header.toString('ascii');
      const size = /^[0-9a-fA-F]{4}$/.test(hex) ? parseInt(hex, 16) : -1;
      if (size === 0) return packets;
      if (size < 4 || size > 65520) throw new Error('invalid Git LFS filter packet size');
      packets.push(readBytes(size - 4)!);
      eof = false;
    }
  }
  function writeBytes(bytes: Buffer): void {
    let offset = 0;
    while (offset < bytes.length) offset += writeSync(output, bytes, offset, bytes.length - offset);
  }
  function writeList(packets: readonly Buffer[]): void {
    for (const packet of packets) {
      for (let offset = 0; offset < packet.length; offset += 65516) {
        const chunk = packet.subarray(offset, offset + 65516);
        writeBytes(Buffer.from((chunk.length + 4).toString(16).padStart(4, '0')));
        writeBytes(chunk);
      }
    }
    writeBytes(Buffer.from('0000'));
  }
  const hello = readList()?.map((p) => p.toString('utf8'));
  if (hello?.[0] !== 'git-filter-client\n' || !hello.includes('version=2\n')) throw new Error('unsupported Git LFS filter protocol');
  writeList([Buffer.from('git-filter-server\n'), Buffer.from('version=2\n')]);
  const capabilities = readList();
  if (!capabilities?.some((p) => p.toString('utf8') === 'capability=clean\n')) throw new Error('Git LFS filter requires clean capability');
  writeList([Buffer.from('capability=clean\n')]);
  for (;;) {
    const headers = readList(true);
    if (headers === null) return;
    const content = Buffer.concat(readList()!);
    if (!headers.some((p) => p.toString('utf8') === 'command=clean\n')) throw new Error('unsupported Git LFS filter command');
    writeList([Buffer.from('status=success\n')]);
    writeList([lfsClean(content).blob]);
    writeList([]); // No change to the success status after the content.
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === '--lfs-clean') process.stdout.write(lfsClean(readFileSync(0)).blob);
  else if (process.argv[2] === '--lfs-filter-process') lfsFilterProcess(0, 1);
}
