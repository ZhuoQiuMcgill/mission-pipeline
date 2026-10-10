// Representation contract (design 7.1 表示约定; 6.5 生成提交; 6.6 step 7.5).
//
// The program supports exactly three transforms and implements them itself,
// following git's convert.c and the LFS pointer spec, without running any
// external program:
//   - end-of-line conversion (`text`, `eol`, legacy `crlf`, core.autocrlf, core.eol);
//   - `ident`;
//   - Git LFS pointers (lfs.ts).
// Any other content filter, and `working-tree-encoding` (other than UTF-8, which
// git itself treats as a no-op), is unsupported and is reported as such.
//
// - Snapshot (repository -> worktree representation): raw blobs from `cat-file`,
//   converted here (ident, then eol, then LFS smudge, git's order).
// - Commit (worktree -> repository representation): converted here (LFS clean,
//   then eol, then ident), written with `hash-object -w --no-filters`, `mktree`
//   and `commit-tree`. Unchanged files keep their blob ids.
// - Canonicalize, then verify: after a seat returns, the program generates the
//   commit and RE-MATERIALIZES a canonical candidate from it; verification and
//   review run on that candidate, never on the seat's raw bytes.
// - The transform description (attribute sources outside the tree, the
//   effective transform keys, the rules version) is a bound input; its hash goes
//   into the environment snapshot id (7.2) and the landing view uses it (6.6).
// - Attribute evaluation is a pure read: `git check-attr` in a scratch
//   repository whose info/attributes and core.attributesFile hold the bound
//   description's copies and whose objects are the real repository's (alternates).

import { createHash, randomBytes } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
  writeSync,
  type Dirent,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fsyncDir } from '../common/fsx.ts';
import { hashJson } from '../common/hash.ts';
import type { ContentHash, GitOid } from '../common/ids.ts';
import { LFS_POINTER_MAX_BYTES, lfsClean, lfsObjectPath, lfsTempDir, parseLfsPointer, type LfsPointer } from './lfs.ts';
import {
  baseName,
  batchCheck,
  buildTrees,
  commitTree,
  gitObjectId,
  lsTree,
  mktree,
  readObjects,
  repoArgs,
  resolveCommit,
  treeOfCommit,
  writeBlobsFromFiles,
  UTF8,
  type BuiltTree,
  type FileMode,
  type Ident,
  type ObjectFormat,
  type RepoLayout,
  type TreeEntry,
} from './objects.ts';
import type { GitLocators, SafeGit, UserGitEnvironment } from './safeGit.ts';

export const REPRESENTATION_RULES_VERSION = 'mp4-representation/1';

export type RepresentationErrorCode =
  | 'bad-config'
  | 'attributes-not-utf8'
  | 'description-mismatch'
  | 'unsafe-path'
  | 'lfs-object-missing'
  /** review r1 #6: an object in the local LFS store whose bytes are not the pointer's (size and sha256), or a link. */
  | 'lfs-object-corrupt'
  /** v49 (6.6, 7.1): git objects the program needs are not in the repository (partial or shallow clone, pruned); never fetched. */
  | 'object-missing'
  | 'unsupported-transform'
  | 'snapshot-changed'
  | 'git-disagrees';

export class RepresentationError extends Error {
  readonly code: RepresentationErrorCode;
  readonly paths: readonly string[];
  constructor(code: RepresentationErrorCode, message: string, paths: readonly string[] = []) {
    super(message);
    this.name = 'RepresentationError';
    this.code = code;
    this.paths = paths;
  }
}

/**
 * v49 (6.6, 7.1; WI-13): objects a snapshot, a commit or a candidate needs are
 * not in the repository: a partial clone, a shallow clone or pruned objects.
 * The program never fetches them (GIT_NO_LAZY_FETCH from SafeGit, rev-list
 * --missing=print): the work that needs them is not done until they are local.
 * `objects`: the missing object ids; `paths`: where they are used, when known.
 */
export class MissingObjectsError extends RepresentationError {
  readonly objects: readonly string[];
  constructor(message: string, objects: readonly string[], paths: readonly string[] = []) {
    super('object-missing', message, paths);
    this.name = 'MissingObjectsError';
    this.objects = objects;
  }
}

/**
 * The objects of `commit` itself (the commit, its trees and blobs; not its
 * history, not submodule commits) that the repository does not have, listed
 * without fetching anything (`rev-list --missing=print`; SafeGit sets
 * GIT_NO_LAZY_FETCH). Null when that cannot be determined.
 */
export async function missingObjectsOf(git: SafeGit, repo: RepoLayout, commit: string): Promise<string[] | null> {
  const self = await batchCheck(git, repo, [commit as GitOid]).catch(() => null);
  if (self === null) return null;
  const info = self.get(commit as GitOid);
  if (info === null || info === undefined) return /^[0-9a-f]{40}$|^[0-9a-f]{64}$/.test(commit) ? [commit] : null;
  const r = await git.run([...repoArgs(repo), 'rev-list', '--objects', '--no-object-names', '--missing=print', '--no-walk', commit, '--'], {
    cwd: repo.commonDir,
    maxOutputBytes: 1024 * 1024 * 1024,
  });
  if (r.code !== 0) return null;
  return r.stdout
    .toString('utf8')
    .split('\n')
    .filter((l) => l.startsWith('?'))
    .map((l) => l.slice(1).trim());
}

/** Where the missing blobs of `commit` are used (best effort: needs its trees). */
async function pathsUsing(git: SafeGit, repo: RepoLayout, commit: string, missing: ReadonlySet<string>): Promise<string[]> {
  try {
    return (await lsTree(git, repo, commit, { recursive: true })).filter((e) => missing.has(e.oid)).map((e) => e.path);
  } catch {
    return [];
  }
}

/**
 * Runs `work`; when it fails other than with a typed representation error,
 * looks for objects of `commits` that are missing and, if there are any,
 * reports them as MissingObjectsError (WI-13) instead of the raw failure.
 */
export async function missingObjectsAsTyped<T>(git: SafeGit, repo: RepoLayout, commits: readonly string[], what: string, work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (e) {
    if (e instanceof RepresentationError) throw e;
    const missing = new Set<string>();
    const paths = new Set<string>();
    for (const c of commits) {
      const m = await missingObjectsOf(git, repo, c).catch(() => null);
      if (m === null || m.length === 0) continue;
      for (const x of m) missing.add(x);
      for (const p of await pathsUsing(git, repo, c, new Set(m))) paths.add(p);
    }
    if (missing.size === 0) throw e;
    throw new MissingObjectsError(
      `${what}: ${missing.size} git object(s) are not in the repository (a partial or shallow clone, or pruned objects); the program never fetches them`,
      [...missing].sort(),
      [...paths].sort(),
    );
  }
}

// ---------------------------------------------------------------- transform description (7.1)

export type AutoCrlf = 'true' | 'false' | 'input';
export type CoreEol = 'lf' | 'crlf' | 'native' | 'unset';

export interface TransformDescription {
  readonly rulesVersion: string;
  readonly objectFormat: ObjectFormat;
  readonly autocrlf: AutoCrlf;
  readonly eol: CoreEol;
  /** core.ignorecase: attribute patterns match case-insensitively. */
  readonly ignoreCase: boolean;
  /** core.symlinks: false checks symlinks out as plain files holding the target. */
  readonly symlinks: boolean;
  /** core.filemode: false keeps the recorded executable bit instead of reading it from the worktree. */
  readonly fileMode: boolean;
  /** Attribute sources outside the tree (the tree's own .gitattributes are fixed by the commit). Empty files are null. */
  readonly attributes: {
    readonly info: string | null;
    readonly global: string | null;
    readonly system: string | null;
  };
}

export function transformDescriptionHash(d: TransformDescription): ContentHash {
  return hashJson(d);
}

/** Field names that differ, for the PM's explanation (6.6 step 7.5). */
export function transformDescriptionDifferences(bound: TransformDescription, actual: TransformDescription): string[] {
  const out: string[] = [];
  const scalar: (keyof TransformDescription)[] = ['rulesVersion', 'objectFormat', 'autocrlf', 'eol', 'ignoreCase', 'symlinks', 'fileMode'];
  for (const k of scalar) {
    if (bound[k] !== actual[k]) out.push(`${k}: ${JSON.stringify(bound[k])} -> ${JSON.stringify(actual[k])}`);
  }
  for (const k of ['info', 'global', 'system'] as const) {
    if (bound.attributes[k] !== actual.attributes[k]) out.push(`${k} attributes file changed`);
  }
  return out;
}

function parseGitBool(key: string, v: string | null): boolean {
  if (v === null) return true; // `[core] key` without a value is true
  const s = v.toLowerCase();
  if (s === '') return false;
  if (s === 'true' || s === 'yes' || s === 'on') return true;
  if (s === 'false' || s === 'no' || s === 'off') return false;
  const m = /^(-?\d+)([kmg])?$/.exec(s);
  if (m !== null) return Number(m[1]) !== 0;
  throw new RepresentationError('bad-config', `bad boolean value for ${key}: ${JSON.stringify(v)}`);
}

function readAttributesFile(path: string | null): string | null {
  if (path === null || path === '') return null;
  let buf: Buffer;
  try {
    if (!statSync(path).isFile()) return null;
    buf = readFileSync(path);
  } catch {
    return null;
  }
  if (buf.length === 0) return null; // an empty attributes file is the same as none
  try {
    return UTF8.decode(buf);
  } catch {
    throw new RepresentationError('attributes-not-utf8', `attributes file is not UTF-8: ${path}`);
  }
}

/**
 * Reads the effective transform settings of `cwd` (a worktree, or the git dir)
 * from the user's real configuration: pure reads (`git config --get-regexp`,
 * `git var`), nothing executed.
 */
export async function readTransformDescription(
  git: SafeGit,
  repo: RepoLayout,
  user: UserGitEnvironment,
  cwd?: string,
  /** Name the repository (and worktree) explicitly instead of discovering it from `cwd` (landing, 6.6 v37). */
  locators?: GitLocators,
): Promise<TransformDescription> {
  const scope = { kind: 'user', environment: user } as const;
  const where = cwd ?? locators?.workTree ?? repo.worktree ?? repo.commonDir;
  const loc = locators !== undefined ? { locators } : {};
  const r = await git.ok(['config', '-z', '--get-regexp', '^core\\.(autocrlf|eol|ignorecase|symlinks|filemode)$'], {
    cwd: where,
    scope,
    okCodes: [0, 1],
    ...loc,
  });
  const values = new Map<string, string | null>();
  if (r.code === 0) {
    for (const rec of r.stdout.toString('utf8').split('\0')) {
      if (rec === '') continue;
      const nl = rec.indexOf('\n');
      if (nl < 0) values.set(rec, null);
      else values.set(rec.slice(0, nl), rec.slice(nl + 1)); // later sources win
    }
  }
  let autocrlf: AutoCrlf = 'false';
  if (values.has('core.autocrlf')) {
    const v = values.get('core.autocrlf') ?? null;
    autocrlf = v !== null && v.toLowerCase() === 'input' ? 'input' : parseGitBool('core.autocrlf', v) ? 'true' : 'false';
  }
  let eol: CoreEol = 'unset';
  const eolRaw = values.get('core.eol');
  if (eolRaw !== undefined && eolRaw !== null) {
    const s = eolRaw.toLowerCase();
    eol = s === 'lf' || s === 'crlf' || s === 'native' ? s : 'unset';
  }
  const bool = (k: string, dflt: boolean): boolean => (values.has(k) ? parseGitBool(k, values.get(k) ?? null) : dflt);
  const globalPath = await git.run(['var', 'GIT_ATTR_GLOBAL'], { cwd: where, scope, ...loc });
  const systemPath = await git.run(['var', 'GIT_ATTR_SYSTEM'], { cwd: where, scope, ...loc });
  return {
    rulesVersion: REPRESENTATION_RULES_VERSION,
    objectFormat: repo.objectFormat,
    autocrlf,
    eol,
    ignoreCase: bool('core.ignorecase', false),
    symlinks: bool('core.symlinks', true),
    fileMode: bool('core.filemode', true),
    attributes: {
      info: readAttributesFile(join(repo.commonDir, 'info', 'attributes')),
      global: globalPath.code === 0 ? readAttributesFile(globalPath.stdout.toString('utf8').trim()) : null,
      system: systemPath.code === 0 ? readAttributesFile(systemPath.stdout.toString('utf8').trim()) : null,
    },
  };
}

/** System then global attributes in one file: same relative precedence, both below the tree and info/attributes. */
export function combinedGlobalAttributes(d: TransformDescription): string {
  return [d.attributes.system, d.attributes.global]
    .filter((s): s is string => s !== null)
    .map((s) => (s.endsWith('\n') ? s : s + '\n'))
    .join('');
}

// ---------------------------------------------------------------- attributes (pure read)

export type AttrValue =
  | { readonly kind: 'unspecified' }
  | { readonly kind: 'set' }
  | { readonly kind: 'unset' }
  | { readonly kind: 'value'; readonly value: string };

export interface ConversionAttributes {
  readonly text: AttrValue;
  readonly crlf: AttrValue;
  readonly eol: AttrValue;
  readonly ident: AttrValue;
  readonly filter: AttrValue;
  readonly workingTreeEncoding: AttrValue;
}

export const CONVERSION_ATTRIBUTE_NAMES = ['text', 'crlf', 'eol', 'ident', 'filter', 'working-tree-encoding'] as const;

const UNSPECIFIED: AttrValue = { kind: 'unspecified' };

function attrValue(v: string): AttrValue {
  // check-attr cannot tell `text=set` from `text`: such literal values read as the boolean state.
  if (v === 'unspecified') return UNSPECIFIED;
  if (v === 'set') return { kind: 'set' };
  if (v === 'unset') return { kind: 'unset' };
  return { kind: 'value', value: v };
}

function emptyAttributes(): { -readonly [K in keyof ConversionAttributes]: AttrValue } {
  return { text: UNSPECIFIED, crlf: UNSPECIFIED, eol: UNSPECIFIED, ident: UNSPECIFIED, filter: UNSPECIFIED, workingTreeEncoding: UNSPECIFIED };
}

/**
 * Evaluates conversion attributes with exactly the bound transform description.
 * A scratch bare repository borrows the real objects (alternates) and holds the
 * description's info/attributes and global+system attributes; nothing of the
 * live configuration is read and nothing is executed.
 */
export class AttributeEvaluator {
  readonly description: TransformDescription;
  readonly dir: string;
  private readonly git: SafeGit;
  private readonly gitDir: string;

  private constructor(git: SafeGit, description: TransformDescription, dir: string, gitDir: string) {
    this.git = git;
    this.description = description;
    this.dir = dir;
    this.gitDir = gitDir;
  }

  static async create(git: SafeGit, repo: RepoLayout, description: TransformDescription, scratchParent: string): Promise<AttributeEvaluator> {
    if (description.objectFormat !== repo.objectFormat) {
      throw new RepresentationError('description-mismatch', 'transform description is for another object format');
    }
    const dir = mkdtempSync(join(scratchParent, 'mp-attr-'));
    const gitDir = join(dir, 'attr.git');
    // The scratch repository is named explicitly (never discovered), also inside a landing view (6.6 v37).
    const own = { gitDir };
    await git.ok(['init', '--bare', '--quiet', '--template=', `--object-format=${description.objectFormat}`, gitDir], { cwd: dir, locators: own });
    mkdirSync(join(gitDir, 'info'), { recursive: true });
    mkdirSync(join(gitDir, 'objects', 'info'), { recursive: true });
    writeFileSync(join(gitDir, 'info', 'attributes'), description.attributes.info ?? '');
    const globalFile = join(dir, 'global-attributes');
    writeFileSync(globalFile, combinedGlobalAttributes(description));
    writeFileSync(join(gitDir, 'objects', 'info', 'alternates'), join(repo.commonDir, 'objects') + '\n');
    const cfg = join(gitDir, 'config');
    await git.ok(['config', '--file', cfg, 'core.attributesFile', globalFile], { cwd: dir, locators: own });
    await git.ok(['config', '--file', cfg, 'core.ignoreCase', String(description.ignoreCase)], { cwd: dir, locators: own });
    return new AttributeEvaluator(git, description, dir, gitDir);
  }

  /**
   * The same scratch repository queried through another SafeGit (e.g. outside a
   * landing view once the push is over: the scratch repository is the program's
   * own, so its queries do not depend on the user's directories).
   */
  withGit(git: SafeGit): AttributeEvaluator {
    return new AttributeEvaluator(git, this.description, this.dir, this.gitDir);
  }

  /** Attributes as of a tree (its .gitattributes files) plus the bound outside sources. */
  atTree(treeish: string, paths: readonly string[]): Promise<Map<string, ConversionAttributes>> {
    return this.query([`--source=${treeish}`], null, paths);
  }

  /** Attributes as `git add` would see them in a directory (a seat's snapshot). */
  inDirectory(workTree: string, paths: readonly string[]): Promise<Map<string, ConversionAttributes>> {
    return this.query([], workTree, paths);
  }

  private async query(extra: readonly string[], workTree: string | null, paths: readonly string[]): Promise<Map<string, ConversionAttributes>> {
    const out = new Map<string, ConversionAttributes>();
    if (paths.length === 0) return out;
    const args = ['--git-dir', this.gitDir];
    if (workTree !== null) args.push('--work-tree', workTree);
    args.push('check-attr', '-z', '--stdin', ...extra, ...CONVERSION_ATTRIBUTE_NAMES);
    let inputBytes = 0;
    const parts = paths.map((p) => {
      const b = Buffer.from(p + '\0', 'utf8');
      inputBytes += b.length;
      return b;
    });
    const r = await this.git.ok(args, {
      cwd: this.dir,
      locators: workTree === null ? { gitDir: this.gitDir } : { gitDir: this.gitDir, workTree },
      input: Buffer.concat(parts),
      maxOutputBytes: inputBytes * CONVERSION_ATTRIBUTE_NAMES.length + paths.length * 200 + 4096,
    });
    const work = new Map<string, ReturnType<typeof emptyAttributes>>();
    const fields = r.stdout.toString('utf8').split('\0');
    for (let i = 0; i + 2 < fields.length; i += 3) {
      const path = fields[i] as string;
      const attr = fields[i + 1] as string;
      const value = attrValue(fields[i + 2] as string);
      let a = work.get(path);
      if (a === undefined) {
        a = emptyAttributes();
        work.set(path, a);
      }
      switch (attr) {
        case 'text':
          a.text = value;
          break;
        case 'crlf':
          a.crlf = value;
          break;
        case 'eol':
          a.eol = value;
          break;
        case 'ident':
          a.ident = value;
          break;
        case 'filter':
          a.filter = value;
          break;
        case 'working-tree-encoding':
          a.workingTreeEncoding = value;
          break;
      }
    }
    for (const p of paths) out.set(p, work.get(p) ?? emptyAttributes());
    return out;
  }

  dispose(): void {
    rmSync(this.dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------- conversion decision (convert.c convert_attrs)

/** git's crlf_action after convert_attrs resolved CRLF_TEXT, CRLF_AUTO and CRLF_UNDEFINED against the config. */
export type CrlfAction = 'binary' | 'text-input' | 'text-crlf' | 'auto-input' | 'auto-crlf';

export interface PathConversion {
  readonly crlf: CrlfAction;
  readonly ident: boolean;
  readonly lfs: boolean;
  /** Why the program cannot represent this path (7.1: unsupported transforms); null when supported. */
  readonly unsupported: string | null;
}

type RawCrlf = 'binary' | 'text' | 'text-input' | 'text-crlf' | 'auto' | 'auto-input' | 'auto-crlf' | 'undefined';

function crlfFromAttr(v: AttrValue): RawCrlf {
  switch (v.kind) {
    case 'set':
      return 'text';
    case 'unset':
      return 'binary';
    case 'unspecified':
      return 'undefined';
    case 'value':
      return v.value === 'input' ? 'text-input' : v.value === 'auto' ? 'auto' : 'undefined';
  }
}

/** text_eol_is_crlf(): the engine runs on Linux, where the native line end is LF. */
export function textEolIsCrlf(d: TransformDescription): boolean {
  if (d.autocrlf === 'true') return true;
  if (d.autocrlf === 'input') return false;
  return d.eol === 'crlf';
}

function isUtf8Name(s: string): boolean {
  const l = s.toLowerCase();
  return l === 'utf-8' || l === 'utf8';
}

export function resolveConversion(a: ConversionAttributes, d: TransformDescription): PathConversion {
  let action = crlfFromAttr(a.text);
  if (action === 'undefined') action = crlfFromAttr(a.crlf);
  if (action !== 'binary') {
    const eol = a.eol.kind === 'value' ? a.eol.value : null;
    if (action === 'auto' && eol === 'lf') action = 'auto-input';
    else if (action === 'auto' && eol === 'crlf') action = 'auto-crlf';
    else if (eol === 'lf') action = 'text-input';
    else if (eol === 'crlf') action = 'text-crlf';
  }
  if (action === 'text') action = textEolIsCrlf(d) ? 'text-crlf' : 'text-input';
  if (action === 'undefined') action = d.autocrlf === 'false' ? 'binary' : d.autocrlf === 'true' ? 'auto-crlf' : 'auto-input';
  if (action === 'auto') action = textEolIsCrlf(d) ? 'auto-crlf' : 'auto-input';
  const filter = a.filter.kind === 'value' ? a.filter.value : null;
  const wte = a.workingTreeEncoding.kind === 'value' && a.workingTreeEncoding.value !== '' ? a.workingTreeEncoding.value : null;
  let unsupported: string | null = null;
  if (filter !== null && filter !== 'lfs') unsupported = `content filter "${filter}" is not supported (only Git LFS)`;
  else if (wte !== null && !isUtf8Name(wte)) unsupported = `working-tree-encoding=${wte} is not supported`;
  return { crlf: action, ident: a.ident.kind === 'set', lfs: filter === 'lfs', unsupported };
}

export function sameConversion(a: PathConversion, b: PathConversion): boolean {
  return a.crlf === b.crlf && a.ident === b.ident && a.lfs === b.lfs && a.unsupported === b.unsupported;
}

// ---------------------------------------------------------------- byte conversions (convert.c)

export interface TextStat {
  nul: number;
  lonecr: number;
  lonelf: number;
  crlf: number;
  printable: number;
  nonprintable: number;
}

export function gatherStats(buf: Uint8Array): TextStat {
  const s: TextStat = { nul: 0, lonecr: 0, lonelf: 0, crlf: 0, printable: 0, nonprintable: 0 };
  const n = buf.length;
  for (let i = 0; i < n; i++) {
    const c = buf[i] as number;
    if (c === 13) {
      if (i + 1 < n && buf[i + 1] === 10) {
        s.crlf++;
        i++;
      } else s.lonecr++;
      continue;
    }
    if (c === 10) {
      s.lonelf++;
      continue;
    }
    if (c === 127) s.nonprintable++;
    else if (c < 32) {
      if (c === 8 || c === 9 || c === 27 || c === 12) s.printable++;
      else {
        if (c === 0) s.nul++;
        s.nonprintable++;
      }
    } else s.printable++;
  }
  // A trailing ^Z (DOS EOF) does not count as non-printable.
  if (n >= 1 && buf[n - 1] === 0x1a) s.nonprintable--;
  return s;
}

/** convert_is_binary(): bare CR, NUL, or too many non-printables. */
export function isBinaryStat(s: TextStat): boolean {
  if (s.lonecr > 0) return true;
  if (s.nul > 0) return true;
  return Math.floor(s.printable / 128) < s.nonprintable;
}

function hasCrlfInIndexBlob(data: Uint8Array): boolean {
  if (data.length === 0 || data.indexOf(13) < 0) return false;
  const s = gatherStats(data);
  return !isBinaryStat(s) && s.crlf > 0;
}

function isAuto(a: CrlfAction): boolean {
  return a === 'auto-input' || a === 'auto-crlf';
}

/** crlf_to_git(). `indexBlob` is the blob recorded at the path before (the "index" of the safer autocrlf rule). */
export function crlfToGit(src: Buffer, action: CrlfAction, indexBlob: Uint8Array | null): Buffer {
  if (action === 'binary' || src.length === 0) return src;
  const stats = gatherStats(src);
  let convert = stats.crlf > 0;
  if (isAuto(action)) {
    if (isBinaryStat(stats)) return src;
    if (indexBlob !== null && hasCrlfInIndexBlob(indexBlob)) convert = false;
  }
  if (!convert) return src;
  const out = Buffer.allocUnsafe(src.length);
  let j = 0;
  if (isAuto(action)) {
    // Files with a bare CR were rejected as binary above, so every CR is part of a CRLF.
    for (let i = 0; i < src.length; i++) {
      const c = src[i] as number;
      if (c !== 13) out[j++] = c;
    }
  } else {
    for (let i = 0; i < src.length; i++) {
      const c = src[i] as number;
      if (!(c === 13 && i + 1 < src.length && src[i + 1] === 10)) out[j++] = c;
    }
  }
  return Buffer.from(out.subarray(0, j));
}

/** crlf_to_worktree(). */
export function crlfToWorktree(src: Buffer, action: CrlfAction): Buffer {
  if (src.length === 0 || (action !== 'text-crlf' && action !== 'auto-crlf')) return src;
  const stats = gatherStats(src);
  if (stats.lonelf === 0) return src;
  if (action === 'auto-crlf') {
    if (stats.lonecr > 0 || stats.crlf > 0) return src; // the safer autocrlf rule: never touch mixed files
    if (isBinaryStat(stats)) return src;
  }
  const out = Buffer.allocUnsafe(src.length + stats.lonelf);
  let j = 0;
  for (let i = 0; i < src.length; i++) {
    const c = src[i] as number;
    if (c === 10 && !(i > 0 && src[i - 1] === 13)) out[j++] = 13;
    out[j++] = c;
  }
  return Buffer.from(out.subarray(0, j));
}

const DOLLAR = 36;
const CH_I = 73;
const CH_d = 100;
const COLON = 58;
const LF = 10;
const SPACE = 32;

/** count_ident(): "$Id$" and "$Id: ...$" occurrences. */
export function countIdent(src: Uint8Array): number {
  let cnt = 0;
  let i = 0;
  const n = src.length;
  while (i < n) {
    const ch = src[i++];
    if (ch !== DOLLAR) continue;
    if (n - i < 3) break;
    if (src[i] !== CH_I || src[i + 1] !== CH_d) continue;
    const c2 = src[i + 2];
    i += 3;
    if (c2 === DOLLAR) cnt++;
    if (c2 !== COLON) continue;
    while (i < n) {
      const c = src[i++];
      if (c === DOLLAR) {
        cnt++;
        break;
      }
      if (c === LF) break;
    }
  }
  return cnt;
}

/** ident_to_git(): "$Id: anything $" collapses to "$Id$". */
export function identToGit(src: Buffer): Buffer {
  if (countIdent(src) === 0) return src;
  const parts: Buffer[] = [];
  let i = 0;
  const n = src.length;
  for (;;) {
    const dollar = src.indexOf(DOLLAR, i);
    if (dollar < 0) break;
    parts.push(src.subarray(i, dollar + 1));
    i = dollar + 1;
    if (n - i > 3 && src[i] === CH_I && src[i + 1] === CH_d && src[i + 2] === COLON) {
      const d2 = src.indexOf(DOLLAR, i + 3);
      if (d2 < 0) break;
      const nl = src.indexOf(LF, i + 3);
      if (nl >= 0 && nl < d2) continue; // line break before the next dollar
      parts.push(Buffer.from('Id$', 'latin1'));
      i = d2 + 1;
    }
  }
  parts.push(src.subarray(i));
  return Buffer.concat(parts);
}

/** ident_to_worktree(): "$Id$" (and a git-style "$Id: x $") becomes "$Id: <blob id> $". */
export function identToWorktree(src: Buffer, blobOid: string): Buffer {
  if (countIdent(src) === 0) return src;
  const parts: Buffer[] = [];
  let i = 0;
  const n = src.length;
  for (;;) {
    const dollar = src.indexOf(DOLLAR, i);
    if (dollar < 0) break;
    parts.push(src.subarray(i, dollar + 1));
    i = dollar + 1;
    if (n - i < 3 || src[i] !== CH_I || src[i + 1] !== CH_d) continue;
    if (src[i + 2] === DOLLAR) {
      i += 3;
    } else if (src[i + 2] === COLON) {
      const d2 = src.indexOf(DOLLAR, i + 3);
      if (d2 < 0) break; // incomplete keyword
      const nl = src.indexOf(LF, i + 3);
      if (nl >= 0 && nl < d2) continue;
      let spc = -1;
      for (let k = i + 4; k < d2; k++) {
        if (src[k] === SPACE) {
          spc = k;
          break;
        }
      }
      if (spc >= 0 && spc < d2 - 1) continue; // an id from another version control system: keep it
      i = d2 + 1;
    } else continue;
    parts.push(Buffer.from(`Id: ${blobOid} $`, 'latin1'));
  }
  parts.push(src.subarray(i));
  return Buffer.concat(parts);
}

export type WorktreeBytes =
  | { readonly kind: 'bytes'; readonly data: Buffer }
  | { readonly kind: 'lfs-object'; readonly pointer: LfsPointer }
  /** The program cannot produce what git would; `data` is the raw blob. */
  | { readonly kind: 'unsupported'; readonly reason: string; readonly data: Buffer };

/** Repository -> worktree, in git's order: ident, eol, then the LFS smudge. */
export function toWorktree(blob: Buffer, conv: PathConversion, blobOid: GitOid): WorktreeBytes {
  if (conv.unsupported !== null) return { kind: 'unsupported', reason: conv.unsupported, data: blob };
  let data = blob;
  if (conv.ident) data = identToWorktree(data, blobOid);
  data = crlfToWorktree(data, conv.crlf);
  if (conv.lfs) {
    const p = parseLfsPointer(data);
    if (p.kind === 'unsupported') return { kind: 'unsupported', reason: p.reason, data: blob };
    if (p.kind === 'pointer') {
      return p.pointer.size === 0 ? { kind: 'bytes', data: Buffer.alloc(0) } : { kind: 'lfs-object', pointer: p.pointer };
    }
    // Not a pointer: git-lfs smudge passes the content through.
  }
  return { kind: 'bytes', data };
}

/** Worktree -> repository, in git's order: LFS clean, eol, then ident. */
export function toRepository(
  content: Buffer,
  conv: PathConversion,
  indexBlob: Uint8Array | null,
): { readonly blob: Buffer; readonly lfsObject: LfsPointer | null } {
  if (conv.unsupported !== null) throw new RepresentationError('unsupported-transform', conv.unsupported);
  let data = content;
  let lfsObject: LfsPointer | null = null;
  if (conv.lfs) {
    const c = lfsClean(content);
    data = c.blob;
    lfsObject = c.object;
  }
  data = crlfToGit(data, conv.crlf, indexBlob);
  if (conv.ident) data = identToGit(data);
  return { blob: data, lfsObject };
}

// ---------------------------------------------------------------- paths

/** Null when the path may be written into a worktree; otherwise the reason (git's verify_path, NTFS and HFS rules in part). */
export function unsafePathReason(path: string): string | null {
  if (path.length === 0) return 'empty path';
  if (path.includes('\0')) return 'NUL in path';
  for (const comp of path.split('/')) {
    if (comp === '') return 'empty path component';
    if (comp === '.' || comp === '..') return `"${comp}" path component`;
    const lower = comp.toLowerCase();
    if (lower === '.git' || lower === 'git~1' || /^\.git[ .]+$/.test(lower) || lower.startsWith('.git:')) {
      return `"${comp}" names a git directory`;
    }
  }
  return null;
}

function compareBytes(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

export function sha256Hex(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

/** Streams a file: its size and sha256, without holding it in memory. */
export function sha256File(path: string): { readonly size: number; readonly sha256: string } {
  const h = createHash('sha256');
  const buf = Buffer.allocUnsafe(1024 * 1024);
  const fd = openSync(path, 'r');
  let size = 0;
  try {
    for (;;) {
      const n = readSync(fd, buf, 0, buf.length, null);
      if (n === 0) break;
      size += n;
      h.update(buf.subarray(0, n));
    }
  } finally {
    closeSync(fd);
  }
  return { size, sha256: h.digest('hex') };
}

function fileContainsByte(path: string, byte: number): boolean {
  const buf = Buffer.allocUnsafe(1024 * 1024);
  const fd = openSync(path, 'r');
  try {
    for (;;) {
      const n = readSync(fd, buf, 0, buf.length, null);
      if (n === 0) return false;
      if (buf.subarray(0, n).indexOf(byte) >= 0) return true;
    }
  } finally {
    closeSync(fd);
  }
}

// ---------------------------------------------------------------- snapshots (repository -> worktree)

export interface SnapshotEntry {
  readonly path: string;
  readonly mode: FileMode;
  readonly oid: GitOid;
  /** Size and sha256 of the materialized bytes (a symlink: its target); null for gitlinks. */
  readonly size: number | null;
  readonly sha256: string | null;
  /** Regular files only. */
  readonly conversion: PathConversion | null;
}

export interface UnsupportedPath {
  readonly path: string;
  readonly reason: string;
}

export interface SnapshotManifest {
  readonly commit: GitOid;
  readonly tree: GitOid;
  readonly descriptionHash: ContentHash;
  /** Sorted by path (byte order). Excluded paths are not listed. */
  readonly entries: readonly SnapshotEntry[];
  /** Paths materialized raw because the program cannot represent their transform. */
  readonly unsupported: readonly UnsupportedPath[];
}

export interface MaterializeOptions {
  readonly git: SafeGit;
  readonly repo: RepoLayout;
  readonly commit: string;
  /** Carries the bound transform description. */
  readonly attributes: AttributeEvaluator;
  /** Directory to fill (created; must be empty). Omit to compute only the manifest. */
  readonly dest?: string;
  /** Paths left out of the snapshot (e.g. project instruction files, 7.1). */
  readonly exclude?: (path: string) => boolean;
}

function prepareEmptyDir(dir: string): void {
  mkdirSync(dir, { recursive: true });
  if (readdirSync(dir).length !== 0) throw new Error(`${dir} is not empty`);
}

function writeRegular(path: string, data: Uint8Array, executable: boolean): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, data, { mode: executable ? 0o755 : 0o644 });
  chmodSync(path, executable ? 0o755 : 0o644);
}

/**
 * Builds a snapshot directory (worktree representation) from a commit without
 * git's checkout path. Objects missing from the repository are reported as
 * MissingObjectsError (v49, WI-13), never fetched.
 */
export async function materializeSnapshot(opts: MaterializeOptions): Promise<SnapshotManifest> {
  return missingObjectsAsTyped(opts.git, opts.repo, [opts.commit], `snapshot of ${opts.commit}`, () => materializeSnapshotFrom(opts));
}

async function materializeSnapshotFrom(opts: MaterializeOptions): Promise<SnapshotManifest> {
  const { git, repo } = opts;
  const d = opts.attributes.description;
  const commit = await resolveCommit(git, repo, opts.commit);
  if (commit === null) throw new Error(`${opts.commit} is not a commit`);
  const tree = await treeOfCommit(git, repo, commit);
  const entries = (await lsTree(git, repo, commit, { recursive: true })).filter((e) => !(opts.exclude?.(e.path) ?? false));
  const unsafe = entries.filter((e) => unsafePathReason(e.path) !== null);
  if (unsafe.length > 0) {
    throw new RepresentationError('unsafe-path', `commit ${commit} has paths that cannot be materialized`, unsafe.map((e) => e.path));
  }
  if (opts.dest !== undefined) prepareEmptyDir(opts.dest);
  const regular = entries.filter((e) => e.mode === '100644' || e.mode === '100755');
  const attrs = await opts.attributes.atTree(tree, regular.map((e) => e.path));
  const conv = new Map<string, PathConversion>();
  for (const e of regular) conv.set(e.path, resolveConversion(attrs.get(e.path) as ConversionAttributes, d));

  const byOid = new Map<GitOid, TreeEntry[]>();
  const manifest: SnapshotEntry[] = [];
  const unsupported: UnsupportedPath[] = [];
  for (const e of entries) {
    if (e.mode === '160000') {
      if (opts.dest !== undefined) mkdirSync(join(opts.dest, e.path), { recursive: true });
      manifest.push({ path: e.path, mode: '160000', oid: e.oid, size: null, sha256: null, conversion: null });
      continue;
    }
    const list = byOid.get(e.oid);
    if (list === undefined) byOid.set(e.oid, [e]);
    else list.push(e);
  }
  await readObjects(git, repo, [...byOid.keys()], (oid, _type, content) => {
    for (const e of byOid.get(oid) as TreeEntry[]) {
      const dest = opts.dest === undefined ? null : join(opts.dest, e.path);
      if (e.mode === '120000') {
        if (dest !== null) {
          mkdirSync(dirname(dest), { recursive: true });
          if (d.symlinks) symlinkSync(content, dest);
          else writeRegular(dest, content, false);
        }
        manifest.push({ path: e.path, mode: '120000', oid, size: content.length, sha256: sha256Hex(content), conversion: null });
        continue;
      }
      const mode = e.mode as FileMode;
      const c = conv.get(e.path) as PathConversion;
      const w = toWorktree(content, c, oid);
      if (w.kind === 'lfs-object') {
        // review r1 #6: the bytes copied are hashed as they are copied, and only bytes equal to the
        // pointer's size and sha256 become the snapshot's file; the store's object is never trusted by size.
        if (dest !== null) mkdirSync(dirname(dest), { recursive: true });
        copyVerifiedLfsObject(repo.commonDir, w.pointer, dest, mode === '100755' ? 0o755 : 0o644, [e.path]);
        manifest.push({ path: e.path, mode, oid, size: w.pointer.size, sha256: w.pointer.oid, conversion: c });
        continue;
      }
      if (w.kind === 'unsupported') unsupported.push({ path: e.path, reason: w.reason });
      if (dest !== null) writeRegular(dest, w.data, mode === '100755');
      manifest.push({ path: e.path, mode, oid, size: w.data.length, sha256: sha256Hex(w.data), conversion: c });
    }
  });
  manifest.sort((a, b) => compareBytes(a.path, b.path));
  unsupported.sort((a, b) => compareBytes(a.path, b.path));
  return { commit, tree, descriptionHash: transformDescriptionHash(d), entries: manifest, unsupported };
}

// ---------------------------------------------------------------- LFS objects must be local (7.1, v34)

export interface MissingLfsObject {
  readonly path: string;
  readonly pointer: LfsPointer;
  /** missing: not in the local store; corrupt: its bytes are not the pointer's (size or sha256), or it is not a regular file. */
  readonly problem: 'missing' | 'corrupt';
}

export interface LfsPresence {
  readonly ok: boolean;
  readonly missing: readonly MissingLfsObject[];
  /** v49: git objects of the snapshot that are not in the repository (never fetched); absent when none. */
  readonly missingObjects?: readonly string[];
  /** For the user when objects are missing: the program never downloads (no network, no credentials). */
  readonly hint: string | null;
}

/**
 * The scheduler's check before dispatch (7.1 v34: LFS objects must already be
 * local; the program never downloads them). Lists every Git LFS object a
 * snapshot of `commit` would need that is not in the local store. Pure reads.
 */
export async function checkLfsObjectsPresent(o: {
  readonly git: SafeGit;
  readonly repo: RepoLayout;
  readonly commit: GitOid;
  readonly attributes: AttributeEvaluator;
  readonly exclude?: (path: string) => boolean;
}): Promise<LfsPresence> {
  try {
    return await missingObjectsAsTyped(o.git, o.repo, [o.commit], `snapshot of ${o.commit}`, () => lfsPresence(o));
  } catch (e) {
    if (!(e instanceof MissingObjectsError)) throw e;
    // v49 (7.1, WI-13): the snapshot cannot be built: the task is held like one missing LFS objects; nothing is fetched.
    return {
      ok: false,
      missing: [],
      missingObjects: e.objects,
      hint:
        `${e.objects.length} git object(s) of the snapshot are not in the repository (a partial or shallow clone?); ` +
        'the program never fetches them: fetch them into the repository (for a partial clone, for example `git fetch` of the missing objects, or a full clone), then try again.',
    };
  }
}

async function lfsPresence(o: {
  readonly git: SafeGit;
  readonly repo: RepoLayout;
  readonly commit: GitOid;
  readonly attributes: AttributeEvaluator;
  readonly exclude?: (path: string) => boolean;
}): Promise<LfsPresence> {
  const tree = await treeOfCommit(o.git, o.repo, o.commit);
  const listed = (await lsTree(o.git, o.repo, o.commit, { recursive: true })).filter((e) => !(o.exclude?.(e.path) ?? false));
  // v49 (7.1): every blob the snapshot reads must be local; a missing one holds the task (WI-13), never fetched.
  const blobs = listed.filter((e) => e.mode !== '160000');
  const present = await batchCheck(o.git, o.repo, blobs.map((e) => e.oid));
  const notLocal = blobs.filter((e) => present.get(e.oid) == null);
  if (notLocal.length > 0) {
    throw new MissingObjectsError(
      `the snapshot of ${o.commit} needs ${new Set(notLocal.map((e) => e.oid)).size} blob(s) that are not in the repository`,
      [...new Set(notLocal.map((e) => e.oid))].sort(),
      notLocal.map((e) => e.path).sort(),
    );
  }
  const entries = listed.filter((e) => e.mode === '100644' || e.mode === '100755');
  const attrs = await o.attributes.atTree(tree, entries.map((e) => e.path));
  const lfsEntries = entries.filter((e) => resolveConversion(attrs.get(e.path) as ConversionAttributes, o.attributes.description).lfs);
  // Only blobs small enough to be pointers need reading.
  const sizes = await batchCheck(o.git, o.repo, lfsEntries.map((e) => e.oid));
  const small = lfsEntries.filter((e) => (sizes.get(e.oid)?.size ?? LFS_POINTER_MAX_BYTES) < LFS_POINTER_MAX_BYTES);
  const byOid = new Map<GitOid, TreeEntry[]>();
  for (const e of small) {
    const l = byOid.get(e.oid);
    if (l === undefined) byOid.set(e.oid, [e]);
    else l.push(e);
  }
  const missing: MissingLfsObject[] = [];
  await readObjects(o.git, o.repo, [...byOid.keys()], (oid, _t, blob) => {
    for (const e of byOid.get(oid) ?? []) {
      const c = resolveConversion(attrs.get(e.path) as ConversionAttributes, o.attributes.description);
      const w = toWorktree(blob, c, oid);
      if (w.kind !== 'lfs-object') continue;
      // review r1 #6: size AND content (sha256) of the stored object, never the size alone.
      const state = lfsObjectState(o.repo.commonDir, w.pointer);
      if (state !== 'present') missing.push({ path: e.path, pointer: w.pointer, problem: state });
    }
  });
  missing.sort((a, b) => compareBytes(a.path, b.path));
  const corrupt = missing.filter((m) => m.problem === 'corrupt').length;
  const absent = missing.length - corrupt;
  const hints: string[] = [];
  if (absent > 0) hints.push(`${absent} Git LFS object(s) are not available locally; run \`git lfs fetch\` in the repository, then try again.`);
  if (corrupt > 0) {
    hints.push(
      `${corrupt} Git LFS object(s) in the local store do not match their pointers (wrong size or content); ` +
        'run `git lfs fsck` in the repository (it moves corrupt objects aside), then `git lfs fetch`, then try again.',
    );
  }
  return { ok: missing.length === 0, missing, hint: hints.length === 0 ? null : hints.join(' ') };
}

// ---------------------------------------------------------------- verified LFS objects (review r1 #6)

/** Opens an LFS store object without following a link and without blocking on a FIFO; null when absent. */
function openLfsObject(path: string): number | null {
  try {
    return openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return null;
    if (code === 'ELOOP') return -1; // a symlink where the object should be
    throw e;
  }
}

const verifiedLfs = new Map<string, string>();

function lfsCacheKey(path: string, st: { dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number }): string {
  return `${path}\0${st.dev}\0${st.ino}\0${st.size}\0${st.mtimeMs}\0${st.ctimeMs}`;
}

/**
 * Whether the local store holds `pointer`'s object: a regular file (never a
 * link) whose size and sha256 are the pointer's. Content is hashed; an object
 * whose file did not change since it was last verified (same inode, size,
 * mtime and ctime) is not hashed again in this process.
 */
export function lfsObjectState(commonDir: string, pointer: LfsPointer): 'present' | 'missing' | 'corrupt' {
  const path = lfsObjectPath(commonDir, pointer.oid);
  const fd = openLfsObject(path);
  if (fd === null) return 'missing';
  if (fd === -1) return 'corrupt';
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.size !== pointer.size) return 'corrupt';
    const key = lfsCacheKey(path, st);
    if (verifiedLfs.get(key) === pointer.oid) return 'present';
    const h = createHash('sha256');
    const buf = Buffer.allocUnsafe(1024 * 1024);
    let size = 0;
    for (;;) {
      const n = readSync(fd, buf, 0, buf.length, null);
      if (n === 0) break;
      size += n;
      h.update(buf.subarray(0, n));
    }
    if (size !== pointer.size || h.digest('hex') !== pointer.oid) return 'corrupt';
    verifiedLfs.set(key, pointer.oid);
    return 'present';
  } finally {
    closeSync(fd);
  }
}

/**
 * Copies `pointer`'s object out of the local store into `dest` (or only reads
 * it, `dest` null), hashing the bytes as they are copied: the destination is a
 * temporary file renamed into place only when the bytes read are exactly the
 * pointer's size and sha256, so what lands is exactly what was verified.
 * Missing -> lfs-object-missing; a link, another file type or other bytes ->
 * lfs-object-corrupt (nothing is left at `dest`).
 */
export function copyVerifiedLfsObject(commonDir: string, pointer: LfsPointer, dest: string | null, fileMode: number, paths: readonly string[]): void {
  const src = lfsObjectPath(commonDir, pointer.oid);
  const fd = openLfsObject(src);
  if (fd === null) throw new RepresentationError('lfs-object-missing', `LFS object ${pointer.oid} for ${paths.join(', ')} is not in the local LFS store`, paths);
  if (fd === -1) throw new RepresentationError('lfs-object-corrupt', `LFS object ${pointer.oid} is a symlink, not an object file`, paths);
  const tmp = dest === null ? null : `${dest}.mp-lfs-${randomBytes(6).toString('hex')}`;
  let wfd: number | null = null;
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) throw new RepresentationError('lfs-object-corrupt', `LFS object ${pointer.oid} is not a regular file`, paths);
    if (st.size !== pointer.size) throw new RepresentationError('lfs-object-corrupt', `LFS object ${pointer.oid} has size ${st.size}, pointer says ${pointer.size}`, paths);
    if (tmp !== null) wfd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, fileMode);
    const h = createHash('sha256');
    const buf = Buffer.allocUnsafe(1024 * 1024);
    let size = 0;
    for (;;) {
      const n = readSync(fd, buf, 0, buf.length, null);
      if (n === 0) break;
      size += n;
      if (size > pointer.size) break; // grew while being read: wrong in any case
      h.update(buf.subarray(0, n));
      if (wfd !== null) {
        let off = 0;
        while (off < n) off += writeSync(wfd, buf, off, n - off);
      }
    }
    const got = h.digest('hex');
    if (size !== pointer.size || got !== pointer.oid) {
      throw new RepresentationError('lfs-object-corrupt', `LFS object ${pointer.oid} in the local store holds other bytes (${size} bytes, sha256 ${got}); the pointer says ${pointer.size} bytes, sha256 ${pointer.oid}`, paths);
    }
    if (wfd !== null && tmp !== null && dest !== null) {
      closeSync(wfd);
      wfd = null;
      chmodSync(tmp, fileMode);
      renameSync(tmp, dest);
    }
  } finally {
    closeSync(fd);
    if (wfd !== null) closeSync(wfd);
    if (tmp !== null) rmSync(tmp, { force: true });
  }
}

/** The worktree bytes of one blob under a conversion (verification after landing, 6.6). */
export function expectedWorktreeBytes(blob: Buffer, conv: PathConversion, blobOid: GitOid): WorktreeBytes {
  return toWorktree(blob, conv, blobOid);
}

// ---------------------------------------------------------------- commits (worktree -> repository)

export type RejectionCode =
  | 'description-mismatch'
  | 'unsupported-transform'
  | 'unsafe-path'
  | 'special-file'
  | 'non-utf8-path'
  | 'excluded-path-written'
  | 'gitlink-modified';

/** A seat result the program refuses before generating a commit (7.1: never hand the user a commit that is already wrong). */
export interface RepresentationRejection {
  readonly code: RejectionCode;
  readonly detail: string;
  readonly paths: readonly string[];
}

export interface PlanOptions {
  readonly git: SafeGit;
  readonly repo: RepoLayout;
  /** Manifest of the snapshot the seat started from. */
  readonly base: SnapshotManifest;
  /** The seat's snapshot directory after it returned. */
  readonly snapshotDir: string;
  readonly attributes: AttributeEvaluator;
  readonly exclude?: (path: string) => boolean;
}

type BlobSource =
  | { readonly kind: 'regular'; readonly file: string; readonly conversion: PathConversion; readonly indexBlobOid: GitOid | null; readonly identity: boolean }
  | { readonly kind: 'symlink-target'; readonly file: string; readonly isLink: boolean };

export interface NewBlob {
  readonly path: string;
  /** Computed here; git must return the same id when it writes the blob. */
  readonly oid: GitOid;
  /** Size in the repository representation. */
  readonly size: number;
  readonly source: BlobSource;
}

export interface CommitPlan {
  readonly baseCommit: GitOid;
  readonly baseTree: GitOid;
  readonly tree: GitOid;
  readonly objectFormat: ObjectFormat;
  readonly files: ReadonlyMap<string, { readonly mode: FileMode; readonly oid: GitOid }>;
  readonly newBlobs: readonly NewBlob[];
  /** Trees not already in the base, children first. */
  readonly newTrees: readonly BuiltTree[];
  readonly lfsObjects: readonly { readonly pointer: LfsPointer; readonly file: string }[];
  readonly added: readonly string[];
  readonly modified: readonly string[];
  readonly deleted: readonly string[];
  readonly modeChanged: readonly string[];
}

export type PlanResult = { readonly ok: true; readonly plan: CommitPlan } | { readonly ok: false; readonly rejection: RepresentationRejection };

type Found =
  | { readonly kind: 'file'; readonly file: string; readonly executable: boolean }
  | { readonly kind: 'symlink'; readonly file: string }
  | { readonly kind: 'dir'; readonly file: string; readonly empty: boolean };

function reject(code: RejectionCode, detail: string, paths: readonly string[] = []): PlanResult {
  return { ok: false, rejection: { code, detail, paths } };
}

/** Walks a seat's snapshot. Returns found entries, or a rejection. */
function walkSnapshot(
  root: string,
  gitlinks: ReadonlySet<string>,
): { found: Map<string, Found>; rejection: RepresentationRejection | null } {
  const found = new Map<string, Found>();
  const stack: string[] = [''];
  while (stack.length > 0) {
    const rel = stack.pop() as string;
    const abs = rel === '' ? root : join(root, rel);
    let list: Dirent<Buffer>[];
    try {
      list = readdirSync(abs, { withFileTypes: true, encoding: 'buffer' });
    } catch (e) {
      return { found, rejection: { code: 'special-file', detail: `cannot read directory ${rel}: ${String(e)}`, paths: [rel] } };
    }
    if (gitlinks.has(rel)) {
      if (list.length > 0) return { found, rejection: { code: 'gitlink-modified', detail: `submodule directory ${rel} has content`, paths: [rel] } };
      found.set(rel, { kind: 'dir', file: abs, empty: true });
      continue;
    }
    for (const ent of list) {
      let name: string;
      try {
        name = UTF8.decode(ent.name);
      } catch {
        return { found, rejection: { code: 'non-utf8-path', detail: `file name is not UTF-8 under ${rel || '.'}`, paths: [rel] } };
      }
      const p = rel === '' ? name : `${rel}/${name}`;
      const why = unsafePathReason(p);
      if (why !== null) return { found, rejection: { code: 'unsafe-path', detail: `${p}: ${why}`, paths: [p] } };
      const full = join(root, p);
      const st = lstatSync(full);
      if (st.isSymbolicLink()) found.set(p, { kind: 'symlink', file: full });
      else if (st.isFile()) found.set(p, { kind: 'file', file: full, executable: (st.mode & 0o100) !== 0 });
      else if (st.isDirectory()) {
        if (gitlinks.has(p)) found.set(p, { kind: 'dir', file: full, empty: readdirSync(full).length === 0 });
        stack.push(p);
      } else return { found, rejection: { code: 'special-file', detail: `${p} is not a regular file, symlink or directory`, paths: [p] } };
    }
  }
  return { found, rejection: null };
}

/**
 * Plans the commit for a seat's snapshot: what changed, the repository bytes of
 * every changed file, and every new object, without writing anything. Rejects
 * results the program cannot represent (7.1).
 */
export async function planCommit(opts: PlanOptions): Promise<PlanResult> {
  const { git, repo, base } = opts;
  const d = opts.attributes.description;
  if (base.descriptionHash !== transformDescriptionHash(d)) {
    return reject('description-mismatch', 'the snapshot was materialized under another transform description');
  }
  const format = repo.objectFormat;
  const baseEntries = new Map<string, TreeEntry>();
  const baseTreeOids = new Set<GitOid>([base.tree]);
  for (const e of await lsTree(git, repo, base.commit, { recursive: true, withTrees: true })) {
    if (e.type === 'tree') baseTreeOids.add(e.oid);
    else baseEntries.set(e.path, e);
  }
  const manifest = new Map<string, SnapshotEntry>();
  for (const e of base.entries) manifest.set(e.path, e);
  const excluded = (p: string): boolean => opts.exclude?.(p) ?? false;
  for (const p of baseEntries.keys()) {
    if (!excluded(p) && !manifest.has(p)) throw new Error(`manifest does not list ${p}: wrong manifest or exclude predicate`);
    if (excluded(p) && baseName(p) === '.gitattributes') throw new Error('.gitattributes files cannot be excluded from snapshots');
  }
  const gitlinks = new Set([...baseEntries.values()].filter((e) => e.mode === '160000' && !excluded(e.path)).map((e) => e.path));
  const walked = walkSnapshot(opts.snapshotDir, gitlinks);
  if (walked.rejection !== null) return { ok: false, rejection: walked.rejection };
  const found = walked.found;

  const files = new Map<string, { mode: FileMode; oid: GitOid }>();
  const added: string[] = [];
  const modified: string[] = [];
  const deleted: string[] = [];
  const modeChanged: string[] = [];
  const excludedWritten: string[] = [];
  const toConvert: { path: string; file: string; mode: FileMode }[] = [];
  const newBlobs: NewBlob[] = [];

  // Excluded paths come from the base unchanged.
  for (const [p, e] of baseEntries) if (excluded(p)) files.set(p, { mode: e.mode as FileMode, oid: e.oid });

  for (const [p, f] of found) {
    if (excluded(p)) {
      if (f.kind !== 'dir') excludedWritten.push(p);
      continue;
    }
    if (f.kind === 'dir') {
      const be = baseEntries.get(p);
      if (be !== undefined && be.mode === '160000') files.set(p, { mode: '160000', oid: be.oid });
      continue;
    }
    const m = manifest.get(p);
    const wasLink = m !== undefined && m.mode === '120000';
    const isLink = f.kind === 'symlink' || (f.kind === 'file' && !d.symlinks && wasLink);
    const sha = f.kind === 'symlink' ? sha256Hex(readlinkSync(f.file, { encoding: 'buffer' })) : sha256File(f.file).sha256;
    let mode: FileMode;
    if (isLink) mode = '120000';
    else if (d.fileMode) mode = (f as Found & { kind: 'file' }).executable ? '100755' : '100644';
    else mode = m !== undefined && (m.mode === '100644' || m.mode === '100755') ? m.mode : '100644';
    const sameKind = m !== undefined && (isLink ? m.mode === '120000' : m.mode === '100644' || m.mode === '100755');
    if (m !== undefined && sameKind && m.sha256 === sha) {
      files.set(p, { mode, oid: m.oid });
      if (mode !== m.mode) modeChanged.push(p);
      continue;
    }
    if (m === undefined) added.push(p);
    else modified.push(p);
    if (isLink) {
      const bytes = f.kind === 'symlink' ? readlinkSync(f.file, { encoding: 'buffer' }) : readFileSync(f.file);
      const oid = gitObjectId(format, 'blob', bytes);
      files.set(p, { mode, oid });
      newBlobs.push({ path: p, oid, size: bytes.length, source: { kind: 'symlink-target', file: f.file, isLink: f.kind === 'symlink' } });
    } else {
      toConvert.push({ path: p, file: f.file, mode });
    }
  }
  if (excludedWritten.length > 0) {
    return reject('excluded-path-written', 'the seat wrote paths that are excluded from snapshots', excludedWritten.sort(compareBytes));
  }
  for (const e of manifest.values()) {
    if (!found.has(e.path)) deleted.push(e.path);
  }

  // Attributes as `git add` would see them in the snapshot.
  const changedSet = new Set([...added, ...modified, ...deleted]);
  const attrsChanged = [...changedSet].some((p) => baseName(p) === '.gitattributes');
  const regularFinal = [...files.entries()].filter(([, v]) => v.mode === '100644' || v.mode === '100755').map(([p]) => p);
  const queryPaths = attrsChanged
    ? [...new Set([...regularFinal, ...toConvert.map((t) => t.path)])].filter((p) => !excluded(p))
    : toConvert.map((t) => t.path);
  const newAttrs = await opts.attributes.inDirectory(opts.snapshotDir, queryPaths);
  const newConv = new Map<string, PathConversion>();
  for (const p of queryPaths) newConv.set(p, resolveConversion(newAttrs.get(p) as ConversionAttributes, d));

  const unsupported: string[] = [];
  for (const t of toConvert) {
    const c = newConv.get(t.path) as PathConversion;
    if (c.unsupported !== null) unsupported.push(t.path);
  }
  if (attrsChanged) {
    // An attribute change must not make an untouched path use an unsupported transform (7.1).
    for (const p of regularFinal) {
      const before = manifest.get(p)?.conversion ?? null;
      const after = newConv.get(p);
      if (after !== undefined && after.unsupported !== null && (before === null || before.unsupported === null)) unsupported.push(p);
    }
  }
  if (unsupported.length > 0) {
    const reasons = [...new Set(unsupported.map((p) => (newConv.get(p) as PathConversion).unsupported))].join('; ');
    return reject('unsupported-transform', reasons, [...new Set(unsupported)].sort(compareBytes));
  }

  // The safer-autocrlf rule reads the blob previously recorded at the path.
  const needIndex = toConvert.filter((t) => {
    const c = newConv.get(t.path) as PathConversion;
    const be = baseEntries.get(t.path);
    return isAuto(c.crlf) && be !== undefined && (be.mode === '100644' || be.mode === '100755') && fileContainsByte(t.file, 13);
  });
  const indexBlobs = new Map<GitOid, Buffer>();
  await readObjects(
    git,
    repo,
    needIndex.map((t) => (baseEntries.get(t.path) as TreeEntry).oid),
    (oid, _type, content) => {
      indexBlobs.set(oid, content);
    },
  );
  const lfsObjects: { pointer: LfsPointer; file: string }[] = [];
  // One file at a time: read, convert, hash, drop.
  for (const t of toConvert) {
    const c = newConv.get(t.path) as PathConversion;
    const be = baseEntries.get(t.path);
    const indexOid = be !== undefined && indexBlobs.has(be.oid) ? be.oid : null;
    const content = readFileSync(t.file);
    const { blob, lfsObject } = toRepository(content, c, indexOid === null ? null : (indexBlobs.get(indexOid) as Buffer));
    const oid = gitObjectId(format, 'blob', blob);
    files.set(t.path, { mode: t.mode, oid });
    newBlobs.push({
      path: t.path,
      oid,
      size: blob.length,
      source: { kind: 'regular', file: t.file, conversion: c, indexBlobOid: indexOid, identity: blob.equals(content) },
    });
    if (lfsObject !== null) lfsObjects.push({ pointer: lfsObject, file: t.file });
  }

  const trees = buildTrees(format, files);
  const root = trees[trees.length - 1] as BuiltTree;
  return {
    ok: true,
    plan: {
      baseCommit: base.commit,
      baseTree: base.tree,
      tree: root.oid,
      objectFormat: format,
      files,
      newBlobs: newBlobs.sort((a, b) => compareBytes(a.path, b.path)),
      newTrees: trees.filter((t) => !baseTreeOids.has(t.oid)),
      lfsObjects,
      added: added.sort(compareBytes),
      modified: modified.sort(compareBytes),
      deleted: deleted.sort(compareBytes),
      modeChanged: modeChanged.sort(compareBytes),
    },
  };
}

export interface CommitWriteSizes {
  /** New blobs, trees and the commit, with their uncompressed sizes (6.5: git object directory). */
  readonly newObjects: readonly { readonly type: 'blob' | 'tree' | 'commit'; readonly size: number }[];
  /** New LFS objects (6.5: LFS object directory). */
  readonly lfsObjectSizes: readonly number[];
  /** Converted contents staged as temporary files for hash-object. */
  readonly tempFileSizes: readonly number[];
}

export function commitWriteSizes(plan: CommitPlan, message: string, author: Ident, committer: Ident): CommitWriteSizes {
  const hex = plan.objectFormat === 'sha1' ? 40 : 64;
  const identLen = (i: Ident): number => Buffer.byteLength(i.name) + Buffer.byteLength(i.email) + 64;
  const commitSize = 2 * (hex + 16) + identLen(author) + identLen(committer) + Buffer.byteLength(message) + 64;
  return {
    newObjects: [
      ...plan.newBlobs.map((b) => ({ type: 'blob' as const, size: b.size })),
      ...plan.newTrees.map((t) => ({ type: 'tree' as const, size: t.size })),
      { type: 'commit' as const, size: commitSize },
    ],
    lfsObjectSizes: plan.lfsObjects.map((o) => o.pointer.size),
    tempFileSizes: plan.newBlobs.filter((b) => b.source.kind !== 'regular' || !b.source.identity || b.source.file.includes('\n')).map((b) => b.size),
  };
}

async function blobBytesFor(git: SafeGit, repo: RepoLayout, nb: NewBlob): Promise<Buffer> {
  const s = nb.source;
  if (s.kind === 'symlink-target') return s.isLink ? readlinkSync(s.file, { encoding: 'buffer' }) : readFileSync(s.file);
  const content = readFileSync(s.file);
  let index: Buffer | null = null;
  if (s.indexBlobOid !== null) {
    await readObjects(git, repo, [s.indexBlobOid], (_o, _t, c) => {
      index = c;
    });
  }
  return toRepository(content, s.conversion, index).blob;
}

function copyWithSha256(src: string, dst: string): string {
  const h = createHash('sha256');
  const buf = Buffer.allocUnsafe(1024 * 1024);
  const rfd = openSync(src, 'r');
  const wfd = openSync(dst, 'wx', 0o644);
  try {
    for (;;) {
      const n = readSync(rfd, buf, 0, buf.length, null);
      if (n === 0) break;
      h.update(buf.subarray(0, n));
      let off = 0;
      while (off < n) off += writeSync(wfd, buf, off, n - off);
    }
    fsyncSync(wfd);
  } finally {
    closeSync(rfd);
    closeSync(wfd);
  }
  return h.digest('hex');
}

/**
 * Puts an LFS object into the repository's LFS store: temp file, fsync, rename,
 * directory fsync. An object already there is kept only when it verifies (a
 * regular file with the pointer's size and sha256, review r1 #6); one that does
 * not (other bytes of the same size, a link) is replaced by the verified copy.
 */
export function storeLfsObject(commonDir: string, sourceFile: string, pointer: LfsPointer): void {
  const dest = lfsObjectPath(commonDir, pointer.oid);
  if (lfsObjectState(commonDir, pointer) === 'present') return;
  mkdirSync(dirname(dest), { recursive: true });
  const tmpDir = lfsTempDir(commonDir);
  mkdirSync(tmpDir, { recursive: true });
  const tmp = join(tmpDir, `${pointer.oid}-${randomBytes(6).toString('hex')}.tmp`);
  try {
    const got = copyWithSha256(sourceFile, tmp);
    if (got !== pointer.oid) throw new RepresentationError('snapshot-changed', `LFS content of ${sourceFile} changed after planning`);
    renameSync(tmp, dest);
    fsyncDir(dirname(dest));
  } finally {
    rmSync(tmp, { force: true });
  }
}

export interface WriteCommitOptions {
  readonly message: string;
  readonly author: Ident;
  readonly committer: Ident;
  /** Scratch space for converted contents (outside the repository). */
  readonly tempDir: string;
}

/**
 * Writes the planned objects and the commit (parent: the base commit). Every
 * object id git returns is checked against the id computed while planning, so
 * a filter or a concurrent change of the snapshot cannot slip in unnoticed.
 */
export async function writeCommit(git: SafeGit, repo: RepoLayout, plan: CommitPlan, opts: WriteCommitOptions): Promise<GitOid> {
  const tmp = mkdtempSync(join(opts.tempDir, 'mp-commit-'));
  try {
    const inputs: string[] = [];
    for (let i = 0; i < plan.newBlobs.length; i++) {
      const nb = plan.newBlobs[i] as NewBlob;
      const bytes = await blobBytesFor(git, repo, nb);
      if (gitObjectId(plan.objectFormat, 'blob', bytes) !== nb.oid) {
        throw new RepresentationError('snapshot-changed', `${nb.path} changed after the commit was planned`, [nb.path]);
      }
      if (nb.source.kind === 'regular' && nb.source.identity && !nb.source.file.includes('\n')) {
        inputs.push(nb.source.file);
      } else {
        const p = join(tmp, `b${i}`);
        writeFileSync(p, bytes);
        inputs.push(p);
      }
    }
    // LFS objects before any commit can reference them.
    for (const o of plan.lfsObjects) storeLfsObject(repo.commonDir, o.file, o.pointer);
    const oids = await writeBlobsFromFiles(git, repo, inputs);
    for (let i = 0; i < oids.length; i++) {
      const nb = plan.newBlobs[i] as NewBlob;
      if (oids[i] !== nb.oid) throw new RepresentationError('git-disagrees', `git stored ${nb.path} as ${oids[i]}, expected ${nb.oid}`, [nb.path]);
    }
    for (const t of plan.newTrees) {
      const oid = await mktree(git, repo, t.items);
      if (oid !== t.oid) throw new RepresentationError('git-disagrees', `git wrote tree ${t.dir || '/'} as ${oid}, expected ${t.oid}`);
    }
    return await commitTree(git, repo, plan.tree, [plan.baseCommit], opts.message, opts.author, opts.committer);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

export interface CanonicalizeOptions extends PlanOptions, WriteCommitOptions {
  /** Where the canonical candidate is materialized (created; must be empty). */
  readonly candidateDir: string;
  /** Commit-generation admission (6.5). Return false to stop before anything is written. */
  readonly admit?: (sizes: CommitWriteSizes) => boolean;
}

export type CanonicalizeResult =
  | {
      readonly kind: 'canonical';
      readonly commit: GitOid;
      readonly tree: GitOid;
      readonly plan: CommitPlan;
      /** Manifest of the canonical candidate: what verification and review run on. */
      readonly candidate: SnapshotManifest;
    }
  | { readonly kind: 'rejected'; readonly rejection: RepresentationRejection }
  | { readonly kind: 'not-admitted'; readonly sizes: CommitWriteSizes };

/**
 * 7.1 先规范化，再验证: seat result -> commit (repository representation) ->
 * canonical candidate. Base objects missing from the repository are reported
 * as MissingObjectsError (v49, WI-13), never fetched.
 */
export async function canonicalize(opts: CanonicalizeOptions): Promise<CanonicalizeResult> {
  return missingObjectsAsTyped(opts.git, opts.repo, [opts.base.commit], `commit on ${opts.base.commit}`, () => canonicalizeFrom(opts));
}

async function canonicalizeFrom(opts: CanonicalizeOptions): Promise<CanonicalizeResult> {
  const planned = await planCommit(opts);
  if (!planned.ok) return { kind: 'rejected', rejection: planned.rejection };
  const plan = planned.plan;
  const sizes = commitWriteSizes(plan, opts.message, opts.author, opts.committer);
  if (opts.admit !== undefined && !opts.admit(sizes)) return { kind: 'not-admitted', sizes };
  const commit = await writeCommit(opts.git, opts.repo, plan, opts);
  const candidate = await materializeSnapshot({
    git: opts.git,
    repo: opts.repo,
    commit,
    attributes: opts.attributes,
    dest: opts.candidateDir,
    ...(opts.exclude !== undefined ? { exclude: opts.exclude } : {}),
  });
  return { kind: 'canonical', commit, tree: plan.tree, plan, candidate };
}
