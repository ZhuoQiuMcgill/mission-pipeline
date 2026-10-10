// Which repository formats the program writes to (design v50: 6.6 the config
// view, 6.1; 3.11 WI-13).
//
// - Ref storage: only the files backend. A reftable repository
//   (extensions.refStorage=reftable) gets NO program ref at all: updating one
//   ref there may compact the whole table stack and its lock covers every ref,
//   so neither the landing admission nor 6.1's lock recovery hold. v51: no
//   delivery and no automatic landing either (it is still read, dispatched and
//   produced from); `git refs migrate --ref-format=files` converts it (WI-13).
// - Extensions: objectFormat and worktreeConfig are understood; partialClone is
//   handled by "never fetch" (a missing object is WI-13); refStorage=files is
//   the default. Any other extension is not supported: no ref, no delivery ref,
//   nothing written (WI-13).
// Pure reads through SafeGit: the repository's own config file, named exactly.

import { join } from 'node:path';
import { repoArgs, type RepoLayout } from './objects.ts';
import type { SafeGit } from './safeGit.ts';

const KNOWN_EXTENSIONS: ReadonlySet<string> = new Set(['objectformat', 'worktreeconfig', 'partialclone', 'refstorage']);

export type RepositoryFormat =
  /** The files ref backend and only understood extensions: the program may create its refs. */
  | { readonly kind: 'files' }
  /** reftable: no program ref, no delivery, no automatic landing (WI-13; v51). */
  | { readonly kind: 'reftable' }
  /** Extensions the program does not understand: nothing is written (WI-13). */
  | { readonly kind: 'unsupported'; readonly extensions: readonly string[]; readonly detail: string };

export async function repositoryFormat(git: SafeGit, repo: RepoLayout): Promise<RepositoryFormat> {
  // `--file` reads exactly the repository's config; `-z`: "key\nvalue\0".
  const r = await git.run(['config', '--file', join(repo.commonDir, 'config'), '-z', '--get-regexp', '^extensions\\.'], { cwd: repo.commonDir, locators: { gitDir: repo.commonDir } });
  if (r.code !== 0 && r.code !== 1) throw new Error(`the repository's config cannot be read: ${r.stderr.toString('utf8').trim()}`);
  const ext = new Map<string, string>();
  for (const rec of r.stdout.toString('utf8').split('\0')) {
    if (rec === '') continue;
    const nl = rec.indexOf('\n');
    const key = (nl < 0 ? rec : rec.slice(0, nl)).toLowerCase().slice('extensions.'.length);
    ext.set(key, nl < 0 ? 'true' : rec.slice(nl + 1));
  }
  const unknown = [...ext.keys()].filter((k) => !KNOWN_EXTENSIONS.has(k)).sort();
  if (unknown.length > 0) {
    return { kind: 'unsupported', extensions: unknown.map((k) => `extensions.${k}=${ext.get(k)}`), detail: `the repository uses extensions the program does not support: ${unknown.map((k) => `extensions.${k}`).join(', ')}` };
  }
  const storage = (ext.get('refstorage') ?? 'files').toLowerCase();
  // Cross-checked with git's own answer (git >= 2.45).
  const shown = await git.run([...repoArgs(repo), 'rev-parse', '--show-ref-format'], { cwd: repo.commonDir });
  const format = shown.code === 0 ? shown.stdout.toString('utf8').trim() : storage;
  if (storage === 'reftable' || format === 'reftable') return { kind: 'reftable' };
  if (storage !== 'files' || format !== 'files') {
    return { kind: 'unsupported', extensions: [`extensions.refStorage=${storage}`], detail: `the repository's ref storage ${format} is not supported (only files)` };
  }
  return { kind: 'files' };
}
