// A module's write-scope content identity (5.1: a product version is "the content
// hash of a module's write scope, and a commit"; 6.6 step 4: recomputed on the
// final candidate tree).
//
// Identity = sha256 of canonical JSON over every tree entry inside the write
// scope: [path, mode, object id], sorted by path bytes, in the REPOSITORY
// representation. It is therefore independent of how files are checked out
// (the transform description is bound separately, 7.1/7.2), and any added,
// removed, changed or re-moded file inside the scope changes it, including a
// file the version itself never touched.
//
// The program must record ObjectVersionRecord.content with this same function
// when it records a product version from a generated commit, and put the
// document behind it (writeScopeDocument) into the skeleton's data first
// (memory/data.ts): the memory refuses an object version whose content is not
// stored (6.1), and `data.put(writeScopeDocument(...))` returns exactly the
// identity.

import type { ContentHash, GitOid } from '../common/ids.ts';
import { canonicalJson, sha256 } from '../common/hash.ts';
import { pathMatches } from '../evaluator/semantics.ts';
import { lsTree, type RepoLayout, type TreeEntry } from '../git/objects.ts';
import type { GitExec } from '../git/plainGit.ts';

export const WRITE_SCOPE_IDENTITY_VERSION = 'mp4-write-scope/1';

export function inWriteScope(scope: readonly string[], path: string): boolean {
  return scope.some((p) => pathMatches(p, path));
}

function byPathBytes(a: { path: string }, b: { path: string }): number {
  return Buffer.compare(Buffer.from(a.path, 'utf8'), Buffer.from(b.path, 'utf8'));
}

/**
 * The document whose sha256 is the identity: canonical JSON of
 * {files: [[path, mode, oid], ...], version}. The program stores it in the
 * skeleton's data when it records the version (`data.put` returns the identity).
 */
export function writeScopeDocument(entries: readonly TreeEntry[], scope: readonly string[]): string {
  const files = entries
    .filter((e) => e.type !== 'tree' && inWriteScope(scope, e.path))
    .sort(byPathBytes)
    .map((e) => [e.path, e.mode, e.oid]);
  return canonicalJson({ files, version: WRITE_SCOPE_IDENTITY_VERSION });
}

/** Identity of the entries of a recursive tree listing that fall inside `scope`. */
export function writeScopeIdentity(entries: readonly TreeEntry[], scope: readonly string[]): ContentHash {
  return sha256(writeScopeDocument(entries, scope));
}

/** Identity of a write scope in a commit or tree. */
export async function writeScopeIdentityAt(git: GitExec, repo: RepoLayout, treeish: GitOid, scope: readonly string[]): Promise<ContentHash> {
  return writeScopeIdentity(await lsTree(git, repo, treeish, { recursive: true }), scope);
}
