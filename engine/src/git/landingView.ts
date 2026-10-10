// The controlled configuration view for landing (design 6.6 step 7, "受控配置视图").
//
// Every landing git command (sender, receiver, temp-index measurement, checks)
// runs in a bubblewrap mount namespace where:
// - the repository's config, info/attributes and every config.worktree are
//   replaced by read-only copies the program wrote. The config copy holds only
//   keys that cannot name a program (an allow-list), the transform keys of the
//   BOUND transform description (not re-read from the live config), and forced
//   keys: core.hooksPath -> an empty read-only directory, core.fsmonitor=false,
//   replace refs off (v48: also GIT_NO_REPLACE_OBJECTS and -c on every command
//   line, the receiver's and the hook's included), auto gc off, submodule
//   recursion off. The only content filter defined is Git LFS, and git-lfs never
//   runs (v50): smudge is the program's own (the local LFS store only, verified
//   by size and SHA-256 while streaming, never a transfer), clean is the
//   program's read-only comparator, so no check ever writes into the LFS object
//   store (v48); no filter.lfs.process at all; filter.lfs.required=true (v51).
//   Only extensions.objectFormat and extensions.worktreeConfig are copied (v50).
//   core.attributesFile is never the live path: the bound description's content
//   is written as a read-only copy;
// - the same empty read-only directory is also mounted over .git/hooks (second
//   line of defence: without core.hooksPath git falls back to .git/hooks);
// - the environment starts empty (--clearenv) and holds only PATH, LANG, HOME
//   (an empty directory), GIT_CONFIG_NOSYSTEM=1, GIT_CONFIG_GLOBAL=/dev/null,
//   GIT_ATTR_NOSYSTEM=1, so GIT_CONFIG_COUNT/KEY/VALUE cannot inject anything;
// - the rest of the filesystem is the host's, writable, so the push can update
//   refs, the index and files.
// A local push resets the receiving side's environment and `git -c` does not
// reach it, so receive-side settings go through --receive-pack (probe-git-landing.sh).
//
// The worktree set is FIXED in the namespace (6.6 v35, v36; worktreeRecord.ts):
// when the view is built the program records every registered worktree. Every
// landing command gets its own namespace, computed when it starts:
// - each recorded directory (the common git dir, every linked git dir, every
//   worktree root) is opened read-only without following a symlink, checked
//   against its recorded identity and bound by DESCRIPTOR (bwrap --bind-fd), so
//   moving, renaming or re-registering it afterwards cannot change where the
//   command writes. A mismatch means the command does not run;
// - review r1 #1: a single-file read-only bind on a real directory is detached
//   when the file is renamed from outside (Linux detaches mounts on dentries
//   unlinked or renamed in another mount namespace), after which git reads the
//   new file. So nothing git reads by name from a git dir is overlaid on the
//   real directory any more: the common dir's PATH is a tmpfs only this
//   namespace has, holding the view's config, info and hooks, the recorded
//   locator files and config.worktree copies, and every other entry as a link
//   into the real directory (bound by descriptor at a private path), so the
//   index, refs, objects and logs are still written in the repository through
//   git's own lock-and-rename and stay live. HEAD is live too: a link git
//   accepts as a HEAD ("refs/../HEAD": validate_headref takes a symlink that
//   starts with "refs/") whose target is not a valid ref name, so git reads the
//   real HEAD through it (a HEAD cannot name a program or a write destination);
// - `worktrees/` holds only the linked git dirs the command may see: all of them
//   for checks and for a zero-occupancy push (denyCurrentBranch=refuse), only the
//   approved one for a one-occupancy push (with core.bare=true when it is a
//   linked worktree, so the main worktree is never a candidate), none when the
//   approved one is the main worktree (6.6 v43-v45). A worktree created later on
//   the real filesystem does not exist there at all;
// - the push's commands, the receiving side's settings and the namespace come
//   from ONE generator per occupancy class (pushPlan, 6.6 v47); a one-occupancy
//   receiver updates the worktree only through the program's own push-to-checkout
//   hook (v46, v47), generated per landing with the base and the delivery baked
//   in: it refuses unless HEAD is the base and no index entry is skip-worktree,
//   checks cleanliness with the base's attributes, and runs
//   `read-tree -u -m <base> <delivery>` with the delivery's attributes and sparse
//   checkout off, so it writes exactly the admitted change set, as admitted.
//   git never writes the approved worktree's index through its name (review r2
//   #1: git follows a symlinked `index` and would rewrite its target): the hook
//   works on a private copy (GIT_INDEX_FILE) and the program's index guard takes
//   git's own `index.lock` (O_EXCL, no link followed), then renames the result
//   onto `index` inside the descriptor-bound git dir, only if the lock is still
//   its own and `index` is still the file it copied;
// - the landing never enters a submodule (v46): no submodule.* key is copied,
//   submodule.recurse=false is in the view and on every command line.
// No repository discovery (v37, v38): the view refuses a command that does not
// name its repository in GIT_DIR, which only SafeGit's locators set. The
// sending side names the common dir; the receiving side is reached through the
// push target, the common dir's absolute path, and receive-pack is given no
// locator, so `updateInstead` picks the worktree from the fixed registration and
// git sets that worktree's own locators for its update and its filter.
// The checkout reads attributes from the delivery commit only (--attr-source,
// v47): no .gitattributes file in a worktree or its index, tracked, untracked,
// ignored or written meanwhile, can change how the delivery is materialized
// (review r1 #4).
//
// The sandbox adds --unshare-pid --die-with-parent so killing bwrap on a timeout
// takes every process of the landing with it.

import { randomBytes } from 'node:crypto';
import { chmodSync, closeSync, existsSync, lstatSync, mkdirSync, readdirSync, readlinkSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { RepoLayout } from './objects.ts';
import { combinedGlobalAttributes, type TransformDescription } from './representation.ts';
import { ensureEmptyReadOnlyDir, FIXED_LANG, SYSTEM_PATH, type GitSandbox, type SafeGit, type SpawnSpec } from './safeGit.ts';
import { closeOpened, openRecordedDirs, recordWorktrees, WorktreeIdentityChanged, type OpenedDir, type WorktreeRecord } from './worktreeRecord.ts';

export const DEFAULT_BWRAP = '/usr/bin/bwrap';

/** Keys copied from the real config: none can name a program (6.6: "只从仓库的实际配置里复制不会执行程序的键"). */
const COPY_KEYS: ReadonlySet<string> = new Set([
  'core.repositoryformatversion',
  'core.bare',
  'core.worktree',
  'core.logallrefupdates',
  'core.sharedrepository',
  'core.sparsecheckout',
  'core.sparsecheckoutcone',
  'core.splitindex',
  'core.untrackedcache',
  'core.checkstat',
  'core.trustctime',
  'core.protectntfs',
  'core.protecthfs',
  'core.precomposeunicode',
  'core.compression',
  'core.loosecompression',
  'core.bigfilethreshold',
  'core.safecrlf',
  'core.fsync',
  'core.fsyncmethod',
  'index.version',
  'index.sparse',
  'index.skiphash',
  'splitindex.maxpercentchange',
  'splitindex.sharedindexexpire',
  'feature.manyfiles',
  // v50: only the two known extensions; reftable and any other extension are refused before a view is built.
  'extensions.objectformat',
  'extensions.worktreeconfig',
]);

export function isCopiedConfigKey(key: string): boolean {
  return COPY_KEYS.has(key.toLowerCase());
}

export type ConfigEntry = readonly [key: string, value: string | null];

/** Parses `git config --list -z`: "key\nvalue\0" or "key\0" for a valueless (true) key. */
export function parseConfigList(buf: Buffer): ConfigEntry[] {
  const out: ConfigEntry[] = [];
  for (const rec of buf.toString('utf8').split('\0')) {
    if (rec === '') continue;
    const nl = rec.indexOf('\n');
    out.push(nl < 0 ? [rec, null] : [rec.slice(0, nl), rec.slice(nl + 1)]);
  }
  return out;
}

function quoteConfigValue(v: string): string {
  return '"' + v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\t/g, '\\t').replace(/\x08/g, '\\b') + '"';
}

/** Renders entries as a git config file. Sections and names are case-insensitive; subsections keep their case. */
export function renderConfig(entries: readonly ConfigEntry[]): string {
  const sections = new Map<string, string[]>();
  for (const [key, value] of entries) {
    const first = key.indexOf('.');
    const last = key.lastIndexOf('.');
    if (first < 0) throw new TypeError(`bad config key ${key}`);
    const section = key.slice(0, first).toLowerCase();
    const name = key.slice(last + 1);
    const sub = first === last ? null : key.slice(first + 1, last);
    if (!/^[A-Za-z0-9-]+$/.test(section) || !/^[A-Za-z][A-Za-z0-9-]*$/.test(name)) throw new TypeError(`bad config key ${key}`);
    if (sub !== null && /[\n\0]/.test(sub)) throw new TypeError(`bad config subsection in ${key}`);
    const header = sub === null ? `[${section}]` : `[${section} "${sub.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"]`;
    const line = value === null ? `\t${name}` : `\t${name} = ${quoteConfigValue(value)}`;
    const list = sections.get(header);
    if (list === undefined) sections.set(header, [line]);
    else list.push(line);
  }
  let out = '';
  for (const [h, lines] of sections) out += `${h}\n${lines.join('\n')}\n`;
  return out;
}

/** POSIX shell single-quoting. */
export function shellQuote(s: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

/** The common dir and every linked worktree's private dir (`<common>/worktrees/<id>`). */
export function worktreePrivateDirs(commonDir: string): string[] {
  const dirs = [commonDir];
  const wtRoot = join(commonDir, 'worktrees');
  if (existsSync(wtRoot)) {
    for (const id of readdirSync(wtRoot).sort()) {
      const p = join(wtRoot, id);
      if (statSync(p).isDirectory()) dirs.push(p);
    }
  }
  return dirs;
}

/** One mount of the landing namespace, applied in order after `--dev-bind / /`. */
export type MountSpec =
  | { readonly kind: 'ro-bind'; readonly src: string; readonly dst: string }
  | { readonly kind: 'bind'; readonly src: string; readonly dst: string }
  /** An open directory, passed to bwrap as descriptor `fd` (3, 4, ... in the child). */
  | { readonly kind: 'bind-fd'; readonly fd: number; readonly dst: string }
  /** An open file or directory, read-only, by descriptor. */
  | { readonly kind: 'ro-bind-fd'; readonly fd: number; readonly dst: string }
  | { readonly kind: 'tmpfs'; readonly dst: string; readonly sizeBytes: number }
  | { readonly kind: 'dir'; readonly dst: string }
  | { readonly kind: 'symlink'; readonly target: string; readonly dst: string };

export interface BwrapOptions {
  readonly bwrapPath: string;
  /** Mounts in order. */
  readonly mounts: readonly MountSpec[];
  /** Clear the inherited environment first (always true for landing; false only in the probe's negative control). */
  readonly clearEnv: boolean;
  readonly env: Readonly<Record<string, string>>;
  readonly cwd: string;
}

/** The bubblewrap argv (without the command). */
export function bwrapArgv(o: BwrapOptions): string[] {
  // v49: no network in a landing namespace (nothing is ever fetched or downloaded there).
  const args = ['--unshare-pid', '--unshare-net', '--die-with-parent', '--dev-bind', '/', '/'];
  for (const m of o.mounts) {
    switch (m.kind) {
      case 'tmpfs':
        args.push('--size', String(m.sizeBytes), '--tmpfs', m.dst);
        break;
      case 'bind-fd':
        args.push('--bind-fd', String(m.fd), m.dst);
        break;
      case 'ro-bind-fd':
        args.push('--ro-bind-fd', String(m.fd), m.dst);
        break;
      case 'dir':
        args.push('--dir', m.dst);
        break;
      case 'symlink':
        args.push('--symlink', m.target, m.dst);
        break;
      default:
        args.push(m.kind === 'bind' ? '--bind' : '--ro-bind', m.src, m.dst);
    }
  }
  if (o.clearEnv) args.push('--clearenv');
  for (const [k, v] of Object.entries(o.env)) args.push('--setenv', k, v);
  args.push('--chdir', o.cwd);
  return args;
}

export interface LandingViewOptions {
  readonly git: SafeGit;
  readonly repo: RepoLayout;
  /** The transform description the delivery candidate is bound to. */
  readonly description: TransformDescription;
  /** Where the view's files are written: outside the repository and its worktrees; a memory filesystem when possible. */
  readonly scratchDir: string;
  readonly bwrapPath?: string;
  /** The fixed set to use instead of recording it now (recovery: the set recorded before the push). */
  readonly record?: WorktreeRecord;
}

/** What the program's push-to-checkout hook is generated from (6.6 v46-v49). */
export interface CheckoutHookOptions {
  readonly base: string;
  readonly delivery: string;
  /** The approved worktree's recorded git dir: its index is updated only through the program's guard (review r2 #1). */
  readonly approvedGitDir: string;
  /** v49: the Git LFS objects the checkout needs; the hook checks again that each is in the local store. */
  readonly lfsObjects: readonly { readonly oid: string; readonly size: number }[];
  /**
   * Tests only: the hook stops at this point until `<dir>/go` exists (it creates
   * `<dir>/ready` first), so a test can change the worktree or the branch exactly
   * there: when the hook starts, after the last check and before read-tree, or
   * after read-tree and before receive-pack updates the ref.
   */
  readonly barrier?: { readonly at: 'start' | 'before-read-tree' | 'after-read-tree'; readonly dir: string };
}

const OID_RE = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

/**
 * 6.6 v48, v49: the LFS "clean" of every check: it writes nothing (git-lfs's own
 * clean stores the content first). Same answers as git-lfs's clean:
 * - empty input -> empty output;
 * - a valid LFS pointer (the canonical three lines, at most 1024 bytes) -> itself;
 * - a pointer with extension lines -> an error (not supported: WI-13);
 * - anything else -> the canonical pointer of its SHA-256 and size, streamed.
 */
export const LFS_COMPARE_SCRIPT = `// mission-pipeline: read-only LFS clean for checks (design 6.6 v48, v49). Writes nothing.
import { createHash } from 'node:crypto';
const h = createHash('sha256');
let n = 0;
const head = [];
let headLen = 0;
for await (const chunk of process.stdin) {
  h.update(chunk);
  n += chunk.length;
  if (headLen <= 1024) {
    head.push(chunk);
    headLen += chunk.length;
  }
}
const small = n <= 1024 ? Buffer.concat(head) : null;
const text = small === null ? '' : small.toString('latin1');
if (n === 0) {
  // empty in, empty out
} else if (small !== null && /^version https:\\/\\/git-lfs\\.github\\.com\\/spec\\/v1\\noid sha256:[0-9a-f]{64}\\nsize (0|[1-9][0-9]*)\\n$/.test(text)) {
  process.stdout.write(small);
} else if (small !== null && text.startsWith('version https://git-lfs.github.com/spec/v1\\n') && /^ext-/m.test(text)) {
  process.stderr.write('mission-pipeline: Git LFS pointer extensions are not supported (WI-13)\\n');
  process.exitCode = 3;
} else {
  process.stdout.write('version https://git-lfs.github.com/spec/v1\\noid sha256:' + h.digest('hex') + '\\nsize ' + n + '\\n');
}
`;

/**
 * Review r2 #1: the approved worktree's index is never written through its name
 * by git. git resolves a symlinked `index` and would lock and rewrite its target,
 * wherever it is. The hook works on a private copy (GIT_INDEX_FILE) and this
 * guard moves it into place inside the descriptor-bound git dir:
 * - take: `index` must be a regular file; git's own lock `index.lock` is created
 *   (O_EXCL, never following a link) and its identity recorded; the index is
 *   copied (opened without following a link, checked to be the same file);
 * - publish: the lock must still be ours and `index` still the file copied;
 *   the result is written into the lock and renamed onto `index` (the name is
 *   replaced, a link is never followed);
 * - release: removes the lock only if it is still the one this guard created.
 */
export const INDEX_GUARD_SCRIPT = `// mission-pipeline: the landing's index guard (review r2 #1). Never follows a link.
import { closeSync, constants as C, copyFileSync, fstatSync, fsyncSync, lstatSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
const [cmd, realDir, work] = process.argv.slice(2);
const fail = (code, msg) => { process.stderr.write('mission-pipeline: ' + msg + '\\n'); process.exit(code); };
let dfd;
try { dfd = openSync(realDir, C.O_RDONLY | C.O_DIRECTORY | C.O_NOFOLLOW); } catch (e) { fail(2, 'the git dir cannot be opened: ' + e.code); }
const at = (name) => '/proc/self/fd/' + dfd + '/' + name;
const id = (st) => st.dev + ':' + st.ino;
const stateFile = work + '/guard.json';
if (cmd === 'take') {
  let st;
  try { st = lstatSync(at('index')); } catch (e) { fail(2, 'the index cannot be read: ' + e.code); }
  if (!st.isFile()) fail(2, 'the index is not a regular file (a link or something else): not landed');
  let lfd;
  try { lfd = openSync(at('index.lock'), C.O_WRONLY | C.O_CREAT | C.O_EXCL | C.O_NOFOLLOW, 0o644); } catch (e) {
    fail(3, e.code === 'EEXIST' ? 'index.lock exists: another git command holds the index' : 'index.lock cannot be created: ' + e.code);
  }
  const lock = fstatSync(lfd);
  closeSync(lfd);
  writeFileSync(stateFile, JSON.stringify({ lock: id(lock), index: id(st) }));
  const ifd = openSync(at('index'), C.O_RDONLY | C.O_NOFOLLOW);
  const ist = fstatSync(ifd);
  if (id(ist) !== id(st)) { closeSync(ifd); try { unlinkSync(at('index.lock')); } catch {} fail(4, 'the index changed while it was copied'); }
  writeFileSync(work + '/index', readFileSync(ifd));
  closeSync(ifd);
} else if (cmd === 'publish' || cmd === 'release') {
  let state;
  try { state = JSON.parse(readFileSync(stateFile, 'utf8')); } catch { process.exit(cmd === 'release' ? 0 : 5); }
  let lk = null;
  try { lk = lstatSync(at('index.lock')); } catch {}
  const ours = lk !== null && lk.isFile() && id(lk) === state.lock;
  if (cmd === 'release') {
    if (ours) unlinkSync(at('index.lock'));
    process.exit(0);
  }
  if (!ours) fail(5, 'index.lock is no longer the lock this landing created: the index is left alone');
  let cur = null;
  try { cur = lstatSync(at('index')); } catch {}
  if (cur === null || !cur.isFile() || id(cur) !== state.index) {
    unlinkSync(at('index.lock'));
    fail(6, 'the index was replaced during the landing: it is left alone');
  }
  const lfd = openSync(at('index.lock'), C.O_WRONLY | C.O_TRUNC | C.O_NOFOLLOW);
  if (id(fstatSync(lfd)) !== state.lock) { closeSync(lfd); fail(5, 'index.lock changed'); }
  writeFileSync(lfd, readFileSync(work + '/index'));
  fsyncSync(lfd);
  closeSync(lfd);
  renameSync(at('index.lock'), at('index'));
  fsyncSync(dfd);
} else fail(9, 'unknown command ' + cmd);
closeSync(dfd);
void copyFileSync;
`;

/**
 * 6.6 v50: the landing's LFS smudge. It never runs git-lfs and never transfers
 * anything: a canonical pointer is resolved in the local store
 * (`<common>/lfs/objects/<aa>/<bb>/<oid>`, opened without following a link),
 * streamed while its size and SHA-256 are checked; a missing or mismatching
 * object fails the checkout (git discards the output of a failed filter). Input
 * that is not a pointer passes through; empty input gives empty output.
 */
export const LFS_SMUDGE_SCRIPT = `// mission-pipeline: the landing's LFS smudge (design 6.6 v50). Local store only, verified, never a transfer.
import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';
const common = process.argv[2];
const chunks = [];
let n = 0;
for await (const c of process.stdin) {
  n += c.length;
  if (n > 1024) {
    // longer than any pointer: pass through as it comes
    for (const p of chunks) process.stdout.write(p);
    chunks.length = 0;
    process.stdout.write(c);
  } else chunks.push(c);
}
const input = Buffer.concat(chunks);
const m = n > 0 && n <= 1024 ? /^version https:\\/\\/git-lfs\\.github\\.com\\/spec\\/v1\\noid sha256:([0-9a-f]{64})\\nsize (0|[1-9][0-9]*)\\n$/.exec(input.toString('latin1')) : null;
if (n <= 1024 && m === null) process.stdout.write(input);
if (m !== null) {
  const oid = m[1];
  const size = Number(m[2]);
  const path = common + '/lfs/objects/' + oid.slice(0, 2) + '/' + oid.slice(2, 4) + '/' + oid;
  let fd = -1;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (e) {
    process.stderr.write('mission-pipeline: Git LFS object ' + oid + ' is missing locally (' + e.code + '); a landing never fetches\\n');
    process.exit(1);
  }
  if (!fstatSync(fd).isFile()) {
    process.stderr.write('mission-pipeline: Git LFS object ' + oid + ' is not a regular file\\n');
    process.exit(1);
  }
  const h = createHash('sha256');
  const buf = Buffer.allocUnsafe(1024 * 1024);
  let total = 0;
  for (;;) {
    const k = readSync(fd, buf, 0, buf.length, null);
    if (k === 0) break;
    total += k;
    h.update(buf.subarray(0, k));
    process.stdout.write(Buffer.from(buf.subarray(0, k)));
  }
  closeSync(fd);
  if (total !== size || h.digest('hex') !== oid) {
    process.stderr.write('mission-pipeline: Git LFS object ' + oid + ' does not match its pointer\\n');
    process.exit(1);
  }
}
`;

/**
 * The program's push-to-checkout hook (6.6 v46, v47), with the recorded base and
 * the delivery baked in. receive-pack runs it with GIT_DIR and GIT_WORK_TREE of
 * the worktree it would update, inside the landing namespace. It writes nothing
 * unless HEAD is exactly the recorded base and no index entry is skip-worktree;
 * it checks cleanliness the way git's default does, with the base's attributes;
 * then `read-tree -u -m <base> <delivery>` with the delivery's attributes and
 * sparse checkout off, so the paths written are exactly the base-to-delivery
 * change set and the bytes exactly what admission computed. Every command also
 * turns off hooks and submodule recursion.
 */
export function checkoutHookScript(o: {
  readonly gitPath: string;
  readonly noHooksDir: string;
  /** The common dir as the namespace shows it (its `lfs` entry is the real one). */
  readonly commonDir: string;
  /** Review r2 #1: the approved worktree's git dir as bound by descriptor in the namespace, the guard script, node, and a writable work dir. */
  readonly realGitDir: string;
  readonly guard: string;
  readonly nodePath: string;
  readonly workRoot: string;
  readonly base: string;
  readonly delivery: string;
  readonly lfsObjects: CheckoutHookOptions['lfsObjects'];
  readonly barrier?: CheckoutHookOptions['barrier'];
}): string {
  if (!OID_RE.test(o.base) || !OID_RE.test(o.delivery)) throw new TypeError('the hook needs full object ids');
  for (const l of o.lfsObjects) {
    if (!/^[0-9a-f]{64}$/.test(l.oid) || !Number.isSafeInteger(l.size) || l.size < 0) throw new TypeError(`bad LFS object ${JSON.stringify(l)}`);
  }
  const barrier = (at: 'start' | 'before-read-tree' | 'after-read-tree'): string[] =>
    o.barrier !== undefined && o.barrier.at === at
      ? [`: > ${shellQuote(join(o.barrier.dir, 'ready'))}`, `while [ ! -e ${shellQuote(join(o.barrier.dir, 'go'))} ]; do sleep 0.01; done`]
      : [];
  const g = `"$git" -c core.hooksPath="$nohooks" -c submodule.recurse=false -c core.useReplaceRefs=false -c advice.graftFileDeprecated=false`;
  const lfsCheck =
    o.lfsObjects.length === 0
      ? []
      : [
          // v49: every LFS object the checkout needs is in the local store, right before read-tree (the namespace has no network).
          `lfs=${shellQuote(join(o.commonDir, 'lfs', 'objects'))}`,
          'while read -r oid size; do',
          '  f="$lfs/$(printf %s "$oid" | cut -c1-2)/$(printf %s "$oid" | cut -c3-4)/$oid"',
          '  if [ ! -f "$f" ] || [ "$(wc -c < "$f")" -ne "$size" ]; then refuse "the Git LFS object $oid is not in the local store"; fi',
          "done <<'MP_LFS_OBJECTS'",
          ...o.lfsObjects.map((l) => `${l.oid} ${l.size}`),
          'MP_LFS_OBJECTS',
        ];
  return [
    '#!/bin/sh',
    '# mission-pipeline: push-to-checkout hook for one landing (design 6.6 v46-v49). Generated; read-only.',
    'set -eu',
    // A local push strips these for the receiving side: set again for every command of the hook (v48, v49).
    'GIT_NO_REPLACE_OBJECTS=1 GIT_GRAFT_FILE=/dev/null GIT_NO_LAZY_FETCH=1',
    'export GIT_NO_REPLACE_OBJECTS GIT_GRAFT_FILE GIT_NO_LAZY_FETCH',
    `git=${shellQuote(o.gitPath)}`,
    `nohooks=${shellQuote(o.noHooksDir)}`,
    `base=${o.base}`,
    `delivery=${o.delivery}`,
    'refuse() { echo "mission-pipeline: $*" >&2; exit 1; }',
    // receive-pack starts the hook in the git dir; ls-files lists only what is under the current directory.
    '[ -n "${GIT_WORK_TREE:-}" ] && cd "$GIT_WORK_TREE" || refuse "no work tree to update"',
    ...barrier('start'),
    '[ "$#" -eq 1 ] && [ "$1" = "$delivery" ] || refuse "the pushed commit is not the delivery commit $delivery"',
    `head=$(${g} rev-parse --verify --quiet HEAD) || refuse "HEAD cannot be read"`,
    '[ "$head" = "$base" ] || refuse "HEAD $head is not the recorded base $base"',
    // Review r2 #1: git never writes the index through its name; it works on a copy the guard puts in place.
    `node=${shellQuote(o.nodePath)}`,
    `guard=${shellQuote(o.guard)}`,
    `realdir=${shellQuote(o.realGitDir)}`,
    `work=$(mktemp -d ${shellQuote(join(o.workRoot, 'idx-XXXXXX'))}) || refuse "no work directory"`,
    '"$node" "$guard" take "$realdir" "$work" || exit 1',
    `trap '"$node" "$guard" release "$realdir" "$work"' EXIT`,
    'GIT_INDEX_FILE="$work/index"',
    'export GIT_INDEX_FILE',
    `if ${g} ls-files -v | grep -q '^[Ss] '; then refuse "the index has skip-worktree entries"; fi`,
    `${g} --attr-source="$base" update-index -q --ignore-submodules --refresh`,
    `${g} --attr-source="$base" diff-files --quiet --ignore-submodules -- || refuse "the worktree has unstaged changes"`,
    `${g} --attr-source="$base" diff-index --quiet --cached --ignore-submodules "$base" -- || refuse "the index has staged changes"`,
    ...lfsCheck,
    ...barrier('before-read-tree'),
    `${g} --attr-source="$delivery" -c core.sparseCheckout=false -c core.sparseCheckoutCone=false read-tree -u -m "$base" "$delivery"`,
    '"$node" "$guard" publish "$realdir" "$work" || exit 1',
    'trap - EXIT',
    ...barrier('after-read-tree'),
    '',
  ].join('\n');
}

/**
 * Which linked git dirs the PUSH namespace shows (6.6 v43-v45 "目标分支的占用"):
 * - zero: every recorded one (the receiver runs with denyCurrentBranch=refuse and
 *   must see any checkout or operation that holds the target);
 * - linked: only the approved one, and the receiver runs with core.bare=true, so
 *   the main worktree is never a checkout candidate (v45);
 * - main: none: only the main worktree can be selected.
 */
export type PushBinding = { readonly kind: 'zero' } | { readonly kind: 'linked'; readonly gitDir: string } | { readonly kind: 'main' };

/** One landing's push, as generated for its occupancy class (6.6 v47). */
export interface PushPlan {
  readonly binding: PushBinding;
  /** The view the push runs in: its namespace shows the linked git dirs of this class. */
  readonly view: LandingView;
  /** git arguments of the sending side (after SafeGit's forced settings). */
  readonly senderArgs: readonly string[];
  /** The --receive-pack command. */
  readonly receiver: string;
  /** The receiver's core.hooksPath: the empty read-only directory (zero) or this landing's hook directory (one). */
  readonly hooksDir: string;
}

/** Names git may read in a git dir although they do not exist yet: shown as (dangling) links into the real dir, so they are live. */
const LIVE_NAMES: readonly string[] = [
  'index',
  'packed-refs',
  'shallow',
  'rebase-merge',
  'rebase-apply',
  'BISECT_START',
  'BISECT_LOG',
  'BISECT_TERMS',
  'MERGE_HEAD',
  'CHERRY_PICK_HEAD',
  'REVERT_HEAD',
  'sequencer',
];

/** Entries of a git dir that the view provides itself, never from the real dir. */
const VIEW_OWNED_COMMON: ReadonlySet<string> = new Set(['config', 'config.worktree', 'HEAD', 'info', 'hooks', 'worktrees']);
const VIEW_OWNED_ADMIN: ReadonlySet<string> = new Set(['gitdir', 'commondir', 'config.worktree', 'HEAD', 'locked']);

interface ViewFields {
  token: string;
  dir: string;
  homeDir: string;
  configPath: string;
  configEntries: readonly ConfigEntry[];
  bwrapPath: string;
  gitPath: string;
  noHooksDir: string;
  checkoutHooksDir: string | null;
  record: WorktreeRecord;
  /** Read-only copies written at build time, by the git dir they belong to. */
  files: ViewFiles;
  excluded: ReadonlySet<string>;
  push: PushBinding | null;
  parent: LandingView | null;
}

interface ViewFiles {
  readonly config: string;
  readonly infoAttributes: string;
  /** config.worktree copies (with extensions.worktreeConfig), by git dir. */
  readonly worktreeConfig: ReadonlyMap<string, string>;
  /** gitdir and commondir copies of linked git dirs, by git dir. */
  readonly gitdir: ReadonlyMap<string, string>;
  readonly commondir: ReadonlyMap<string, string>;
  /** Copies of the roots' `.git` files, by root (best effort only: see the header). */
  readonly dotGit: ReadonlyMap<string, string>;
  /** Mount points of the private, descriptor-bound real directories, by git dir (the common dir under its own path). */
  readonly real: ReadonlyMap<string, string>;
}

const VIEW_TMPFS_BYTES = 4 * 1024 * 1024;

function depth(p: string): number {
  let n = 0;
  for (const ch of p) if (ch === '/') n++;
  return n;
}

function safeEntries(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/** A built view: files on disk plus the sandbox that applies them. Dispose when done. */
export class LandingView implements GitSandbox {
  /** Unique per view; appears in every landing command line (recovery finds stray processes by it). */
  readonly token: string;
  readonly dir: string;
  readonly homeDir: string;
  readonly configPath: string;
  /** What the view's config holds, as written. */
  readonly configEntries: readonly ConfigEntry[];
  readonly bwrapPath: string;
  readonly gitPath: string;
  readonly noHooksDir: string;
  /** This landing's read-only hooks directory: empty until installCheckoutHook, then only the program's push-to-checkout hook (6.6 v46). */
  readonly checkoutHooksDir: string | null;
  /** The fixed worktree set (6.6 v35-v40): what every command of this landing binds, by identity. */
  readonly record: WorktreeRecord;
  /** The repository's common dir (where `worktrees` lives). */
  readonly commonDir: string;
  /** Worktrees (by git dir) left out of this view's namespace because their directories changed identity (verification only). */
  readonly excluded: ReadonlySet<string>;
  /** Set on the view the push runs in (6.6 v43-v45). */
  readonly push: PushBinding | null;
  /** Mount points bwrap will create on the host because they do not exist (counted by admission). */
  readonly newMountPoints: number;
  /** Tests only: runs after a command's directories were opened and checked, right before the command starts. */
  afterIdentityCheck: ((argv: readonly string[]) => void) | null = null;
  private readonly files: ViewFiles;
  private readonly parent: LandingView | null;

  private constructor(f: ViewFields) {
    this.token = f.token;
    this.dir = f.dir;
    this.homeDir = f.homeDir;
    this.configPath = f.configPath;
    this.configEntries = f.configEntries;
    this.bwrapPath = f.bwrapPath;
    this.gitPath = f.gitPath;
    this.noHooksDir = f.noHooksDir;
    this.checkoutHooksDir = f.checkoutHooksDir;
    this.record = f.record;
    this.commonDir = f.record.commonDir.path;
    this.files = f.files;
    this.excluded = f.excluded;
    this.push = f.push;
    this.parent = f.parent;
    // Everything the view adds lives in its own tmpfs; only the roots' `.git` copies sit on host paths, which exist.
    this.newMountPoints = [...f.files.dotGit.keys()].filter((root) => !existsSync(join(root, '.git'))).length;
  }

  private fields(): ViewFields {
    return {
      token: this.token,
      dir: this.dir,
      homeDir: this.homeDir,
      configPath: this.configPath,
      configEntries: this.configEntries,
      bwrapPath: this.bwrapPath,
      gitPath: this.gitPath,
      noHooksDir: this.noHooksDir,
      checkoutHooksDir: this.checkoutHooksDir,
      record: this.record,
      files: this.files,
      excluded: this.excluded,
      push: this.push,
      parent: this.parent,
    };
  }

  /** The same view without these worktrees (by git dir): their directories are not bound and nothing of theirs is read. */
  excluding(gitDirs: Iterable<string>): LandingView {
    const excluded = new Set(this.excluded);
    for (const g of gitDirs) excluded.add(g);
    return new LandingView({ ...this.fields(), excluded, parent: this.parent ?? this });
  }

  /** The view the push runs in (6.6 v43-v45): which linked git dirs the receiver can see. */
  forPush(binding: PushBinding): LandingView {
    return new LandingView({ ...this.fields(), push: binding, parent: this.parent ?? this });
  }

  /**
   * v46-v49: writes this landing's push-to-checkout hook (the base, the delivery
   * and the LFS objects it needs baked in) as the only file of its read-only
   * directory. Once per view; a one-occupancy push plan needs it.
   */
  installCheckoutHook(o: CheckoutHookOptions): void {
    const dir = this.checkoutHooksDir;
    if (dir === null) throw new Error('this view has no hook directory');
    const hook = join(dir, 'push-to-checkout');
    if (existsSync(hook)) throw new Error('the checkout hook is already installed');
    const realGitDir = this.files.real.get(o.approvedGitDir);
    if (realGitDir === undefined) throw new Error(`${o.approvedGitDir} is not a recorded git dir of this view`);
    const script = checkoutHookScript({
      gitPath: this.gitPath,
      noHooksDir: this.noHooksDir,
      commonDir: this.commonDir,
      realGitDir,
      guard: join(this.dir, 'index-guard.mjs'),
      nodePath: process.execPath,
      workRoot: join(this.dir, 'hook-work'),
      base: o.base,
      delivery: o.delivery,
      lfsObjects: o.lfsObjects,
      ...(o.barrier !== undefined ? { barrier: o.barrier } : {}),
    });
    chmodSync(dir, 0o755);
    try {
      writeFileSync(hook, script, { mode: 0o555 });
    } finally {
      chmodSync(dir, 0o555);
    }
  }

  /** Tests and diagnostics: where a recorded git dir's real directory is mounted (by descriptor) in a command's namespace. */
  realMountOf(gitDir: string): string | null {
    return this.files.real.get(gitDir) ?? null;
  }

  /**
   * The v34-style overlays onto the REAL paths (config, hooks, info/attributes),
   * kept only for the probes' control groups: a single-file overlay on a real
   * directory is detached by a rename from outside (review r1 #1), so landing
   * commands never rely on it.
   */
  pathOverlayMounts(): MountSpec[] {
    return [
      { kind: 'ro-bind', src: this.files.config, dst: join(this.commonDir, 'config') },
      { kind: 'ro-bind', src: this.noHooksDir, dst: join(this.commonDir, 'hooks') },
      { kind: 'ro-bind', src: this.files.infoAttributes, dst: join(this.commonDir, 'info', 'attributes') },
    ];
  }

  static async build(o: LandingViewOptions): Promise<LandingView> {
    const { git, repo, description } = o;
    const scratch = realpathSync(o.scratchDir);
    for (const inside of [repo.commonDir, repo.worktree]) {
      if (inside === null) continue;
      const rel = relative(inside, scratch);
      if (rel === '' || (!rel.startsWith('..') && !rel.startsWith('/'))) throw new TypeError(`the view must live outside the repository: ${o.scratchDir}`);
    }
    // The fixed set, recorded outside any namespace (pure reads), before anything else is decided.
    const record = o.record ?? (await recordWorktrees(git, repo.commonDir, repo.objectFormat));
    const commonDir = record.commonDir.path;
    const token = `mp-landing-${randomBytes(12).toString('hex')}`;
    const dir = join(o.scratchDir, token);
    mkdirSync(dir, { recursive: false, mode: 0o700 });
    const homeDir = join(dir, 'home');
    ensureEmptyReadOnlyDir(homeDir);

    const readConfigFile = async (path: string): Promise<ConfigEntry[]> => {
      if (!existsSync(path)) return [];
      // `--file` reads exactly that file; GIT_DIR names the repository, nothing is discovered.
      const r = await git.ok(['config', '--file', path, '--no-includes', '--list', '-z'], { cwd: dir, locators: { gitDir: commonDir } });
      return parseConfigList(r.stdout);
    };

    const real = await readConfigFile(join(commonDir, 'config'));
    const entries: ConfigEntry[] = real.filter(([k]) => isCopiedConfigKey(k));
    // Transform keys come from the bound description (6.6 step 7.5).
    entries.push(['core.autocrlf', description.autocrlf]);
    if (description.eol !== 'unset') entries.push(['core.eol', description.eol]);
    entries.push(['core.ignorecase', String(description.ignoreCase)]);
    entries.push(['core.symlinks', String(description.symlinks)]);
    entries.push(['core.filemode', String(description.fileMode)]);
    const globalAttrs = combinedGlobalAttributes(description);
    if (globalAttrs !== '') {
      const p = join(dir, 'global-attributes');
      writeFileSync(p, globalAttrs, { mode: 0o444 });
      entries.push(['core.attributesfile', p]);
    }
    // Forced keys.
    entries.push(['core.hookspath', git.noHooksDir]);
    entries.push(['core.fsmonitor', 'false']);
    entries.push(['core.usereplacerefs', 'false']);
    // A new shared index would be written into the view's own git dir, not the repository's: never split here.
    entries.push(['core.splitindex', 'false']);
    entries.push(['receive.autogc', 'false']);
    // v46: the landing never enters a submodule.
    entries.push(['submodule.recurse', 'false']);
    entries.push(['gc.auto', '0']);
    entries.push(['maintenance.auto', 'false']);
    entries.push(['mission-pipeline.landing', token]);
    {
      // v48, v50: a landing never runs git-lfs (its smudge can fetch through a local-directory transfer, which no
      // network isolation stops; its clean stores content before answering). Both are the program's own, by
      // absolute path outside the repository and every worktree: clean is the read-only comparator, smudge reads
      // only the local LFS store, verified while streaming. There is no filter.lfs.process at all.
      const compare = join(dir, 'lfs-compare.mjs');
      const smudge = join(dir, 'lfs-smudge.mjs');
      writeFileSync(compare, LFS_COMPARE_SCRIPT, { mode: 0o444 });
      writeFileSync(smudge, LFS_SMUDGE_SCRIPT, { mode: 0o444 });
      entries.push(['filter.lfs.clean', `${shellQuote(process.execPath)} ${shellQuote(compare)}`]);
      entries.push(['filter.lfs.smudge', `${shellQuote(process.execPath)} ${shellQuote(smudge)} ${shellQuote(commonDir)}`]);
      entries.push(['filter.lfs.required', 'true']);
    }
    const configPath = join(dir, 'config');
    writeFileSync(configPath, renderConfig(entries), { mode: 0o444 });
    // Read the file back through git: the view must say exactly what we meant.
    const back = await readConfigFile(configPath);
    const lastWins = (es: readonly ConfigEntry[]): string[] => {
      const m = new Map<string, string>();
      for (const [k, v] of es) m.set(k.toLowerCase(), `${k.toLowerCase()}=${v ?? ''}`);
      return [...m.values()].sort();
    };
    const want = lastWins(entries);
    const got = lastWins(back);
    if (want.length !== got.length || want.some((w, i) => w !== got[i])) {
      throw new Error(`the view config does not read back as written: ${JSON.stringify({ want, got })}`);
    }
    const infoAttributes = join(dir, 'info-attributes');
    writeFileSync(infoAttributes, description.attributes.info ?? '', { mode: 0o444 });

    // Every recorded worktree's config.worktree is a copy too, keeping only copied keys.
    const worktreeConfigOn = real.some(([k, v]) => k.toLowerCase() === 'extensions.worktreeconfig' && (v === null || v.toLowerCase() === 'true'));
    const worktreeConfig = new Map<string, string>();
    const gitdir = new Map<string, string>();
    const commondir = new Map<string, string>();
    const dotGit = new Map<string, string>();
    const realMounts = new Map<string, string>();
    mkdirSync(join(dir, 'copies'));
    mkdirSync(join(dir, 'real'));
    realMounts.set(commonDir, join(dir, 'real', 'common'));
    mkdirSync(join(dir, 'real', 'common'));
    for (let i = 0; i < record.worktrees.length; i++) {
      const w = record.worktrees[i] as WorktreeRecord['worktrees'][number];
      if (worktreeConfigOn) {
        const kept = (await readConfigFile(join(w.gitDir, 'config.worktree'))).filter(([k]) => isCopiedConfigKey(k));
        const copy = join(dir, 'copies', `config.worktree-${i}`);
        writeFileSync(copy, renderConfig(kept), { mode: 0o444 });
        worktreeConfig.set(w.gitDir, copy);
      }
      if (w.linked) {
        const m = join(dir, 'real', `admin-${i}`);
        mkdirSync(m);
        realMounts.set(w.gitDir, m);
      }
      for (const f of w.files) {
        const copy = join(dir, 'copies', `${i}-${f.path.split('/').pop() as string}`);
        writeFileSync(copy, Buffer.from(f.content, 'base64'), { mode: 0o444 });
        if (f.path === join(w.gitDir, 'gitdir')) gitdir.set(w.gitDir, copy);
        else if (f.path === join(w.gitDir, 'commondir')) commondir.set(w.gitDir, copy);
        else if (w.root !== null && f.path === join(w.root, '.git')) dotGit.set(w.root, copy);
      }
    }
    chmodSync(join(dir, 'copies'), 0o555);
    // Review r2 #1: the index guard, and a work directory for the hook's private index copies.
    writeFileSync(join(dir, 'index-guard.mjs'), INDEX_GUARD_SCRIPT, { mode: 0o444 });
    mkdirSync(join(dir, 'hook-work'), { mode: 0o700 });
    // v46-v49: the place of this landing's push-to-checkout hook (installCheckoutHook writes it once the change set is known).
    const checkoutHooksDir = join(dir, 'checkout-hooks');
    mkdirSync(checkoutHooksDir, { mode: 0o755 });
    chmodSync(checkoutHooksDir, 0o555);
    chmodSync(dir, 0o555);
    return new LandingView({
      token,
      dir,
      homeDir,
      configPath,
      configEntries: entries,
      bwrapPath: o.bwrapPath ?? DEFAULT_BWRAP,
      gitPath: git.gitPath,
      noHooksDir: git.noHooksDir,
      checkoutHooksDir,
      record,
      files: { config: configPath, infoAttributes, worktreeConfig, gitdir, commondir, dotGit, real: realMounts },
      excluded: new Set(),
      push: null,
      parent: null,
    });
  }

  /** The design's allow-list (6.6): nothing else reaches git in the view (the locators are added per operation by SafeGit). */
  gitEnvironment(): Record<string, string> {
    return {
      PATH: SYSTEM_PATH,
      LANG: FIXED_LANG,
      HOME: this.homeDir,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_ATTR_NOSYSTEM: '1',
      // v48: replace objects off. A local push strips this for the receiver, which has it on its command line.
      GIT_NO_REPLACE_OBJECTS: '1',
      // v49: no grafts (raw parent edges only) and never an implicit fetch (a missing object is an error).
      GIT_GRAFT_FILE: '/dev/null',
      GIT_NO_LAZY_FETCH: '1',
    };
  }

  /** The linked git dirs this command's namespace shows. */
  private shownAdminDirs(): Set<string> {
    const linked = this.record.worktrees.filter((w) => w.linked && !this.excluded.has(w.gitDir)).map((w) => w.gitDir);
    const p = this.push;
    if (p === null || p.kind === 'zero') return new Set(linked);
    if (p.kind === 'main') return new Set();
    return new Set(linked.filter((g) => g === p.gitDir));
  }

  /**
   * The namespace of one command (review r1 #1; 6.6 v35-v47). Names git reads
   * from a git dir are resolved in a tmpfs only this namespace has, so nothing
   * renamed or recreated outside can change what git reads there:
   * - the recorded directories (common dir, linked git dirs, roots) are opened,
   *   checked against the record and bound by descriptor: the roots at their
   *   recorded paths, the git dirs at private paths in the view;
   * - the common dir's path is a tmpfs holding the view's config, info and hooks,
   *   a live HEAD (see liveHead) and every other entry as a link into the private
   *   real dir, so writes (index, refs, objects, logs) still reach the repository
   *   through git's own lock-and-rename, and entries such as `index` or
   *   `packed-refs` stay live;
   * - `worktrees/` holds the linked git dirs this command may see, each again a
   *   tmpfs-held view: the recorded locator files and config.worktree copies, a
   *   live HEAD, the rest links.
   * Descriptor i of `fds` is fd 3 + i in bwrap.
   */
  private namespaceFor(opened: readonly OpenedDir[]): { mounts: MountSpec[]; fds: number[]; extra: number[] } {
    const fds: number[] = opened.map((o) => o.fd);
    const extra: number[] = [];
    const fdIndex = (fd: number): number => 3 + fds.indexOf(fd);
    const mounts: MountSpec[] = [];
    /**
     * HEAD stays live: git takes a symlink HEAD that starts with "refs/" as valid
     * (validate_headref) and, when its target is not a valid ref name, reads the
     * file it points to (files_read_raw_ref). "refs/../HEAD" through the `refs`
     * link is the real HEAD; a git dir without `refs` gets a private `refs` dir
     * holding only `mp.lock` (never listed: ".lock" names are skipped) pointing at
     * the real dir. A legacy symlink HEAD keeps its own target.
     */
    const liveHead = (dirFd: number, viewDir: string, realDir: string, presentNames: ReadonlySet<string>): void => {
      const real = `/proc/self/fd/${dirFd}`;
      let st;
      try {
        st = lstatSync(join(real, 'HEAD'));
      } catch {
        return; // no HEAD: git does not take the directory as a git dir at all
      }
      if (st.isSymbolicLink()) {
        mounts.push({ kind: 'symlink', target: readlinkSync(join(real, 'HEAD'), 'utf8'), dst: join(viewDir, 'HEAD') });
        return;
      }
      let refsIsDir = false;
      try {
        refsIsDir = presentNames.has('refs') && lstatSync(join(real, 'refs')).isDirectory();
      } catch {
        refsIsDir = false;
      }
      if (refsIsDir) {
        mounts.push({ kind: 'symlink', target: 'refs/../HEAD', dst: join(viewDir, 'HEAD') });
      } else {
        mounts.push({ kind: 'dir', dst: join(viewDir, 'refs') });
        mounts.push({ kind: 'symlink', target: realDir, dst: join(viewDir, 'refs', 'mp.lock') });
        mounts.push({ kind: 'symlink', target: 'refs/mp.lock/HEAD', dst: join(viewDir, 'HEAD') });
      }
    };
    // Roots at their recorded paths, outermost first.
    const roots = opened.filter((o) => o.role === 'root').sort((a, b) => depth(a.path) - depth(b.path));
    for (const r of roots) mounts.push({ kind: 'bind-fd', fd: fdIndex(r.fd), dst: r.path });
    // The real git dirs at private paths inside the view.
    const common = opened.find((o) => o.role === 'common');
    if (common === undefined) throw new Error('the common dir was not opened');
    const realCommon = this.files.real.get(this.commonDir) as string;
    mounts.push({ kind: 'bind-fd', fd: fdIndex(common.fd), dst: realCommon });
    const admins = opened.filter((o) => o.role === 'admin');
    for (const a of admins) mounts.push({ kind: 'bind-fd', fd: fdIndex(a.fd), dst: this.files.real.get(a.path) as string });

    // The common dir: a tmpfs only this namespace has.
    const c = this.commonDir;
    mounts.push({ kind: 'tmpfs', dst: c, sizeBytes: VIEW_TMPFS_BYTES });
    mounts.push({ kind: 'ro-bind', src: this.files.config, dst: join(c, 'config') });
    const mainCfg = this.files.worktreeConfig.get(c);
    if (mainCfg !== undefined) mounts.push({ kind: 'ro-bind', src: mainCfg, dst: join(c, 'config.worktree') });
    mounts.push({ kind: 'ro-bind', src: this.noHooksDir, dst: join(c, 'hooks') });
    mounts.push({ kind: 'dir', dst: join(c, 'info') });
    mounts.push({ kind: 'ro-bind', src: this.files.infoAttributes, dst: join(c, 'info', 'attributes') });
    for (const e of safeEntries(`/proc/self/fd/${common.fd}/info`)) {
      // v49: info/grafts would rewrite parent edges for every command: it does not exist in the view.
      if (e !== 'attributes' && e !== 'grafts') mounts.push({ kind: 'symlink', target: join(realCommon, 'info', e), dst: join(c, 'info', e) });
    }
    const present = new Set(safeEntries(`/proc/self/fd/${common.fd}`));
    for (const e of new Set([...present, ...LIVE_NAMES])) {
      if (VIEW_OWNED_COMMON.has(e)) continue;
      // A `refs` the real dir lacks would be a dangling link: liveHead then provides it.
      if (e === 'refs' && !present.has('refs')) continue;
      mounts.push({ kind: 'symlink', target: join(realCommon, e), dst: join(c, e) });
    }
    liveHead(common.fd, c, realCommon, present);

    // The linked git dirs this command may see.
    const shown = this.shownAdminDirs();
    if (shown.size > 0 || present.has('worktrees')) mounts.push({ kind: 'dir', dst: join(c, 'worktrees') });
    for (const a of admins) {
      if (!shown.has(a.path)) continue;
      const realAdmin = this.files.real.get(a.path) as string;
      const g = a.path; // the recorded <common>/worktrees/<id>
      mounts.push({ kind: 'dir', dst: g });
      const gd = this.files.gitdir.get(g);
      if (gd !== undefined) mounts.push({ kind: 'ro-bind', src: gd, dst: join(g, 'gitdir') });
      const cd = this.files.commondir.get(g);
      if (cd !== undefined) mounts.push({ kind: 'ro-bind', src: cd, dst: join(g, 'commondir') });
      const wc = this.files.worktreeConfig.get(g);
      if (wc !== undefined) mounts.push({ kind: 'ro-bind', src: wc, dst: join(g, 'config.worktree') });
      const adminPresent = new Set(safeEntries(`/proc/self/fd/${a.fd}`));
      for (const e of new Set([...adminPresent, ...LIVE_NAMES])) {
        if (VIEW_OWNED_ADMIN.has(e)) continue;
        mounts.push({ kind: 'symlink', target: join(realAdmin, e), dst: join(g, e) });
      }
      liveHead(a.fd, g, realAdmin, adminPresent);
    }
    // Best effort only: the roots' `.git` files (nothing in a landing reads them: every command names its repository).
    for (const r of roots) {
      const copy = this.files.dotGit.get(r.path);
      if (copy !== undefined) mounts.push({ kind: 'ro-bind', src: copy, dst: join(r.path, '.git') });
    }
    return { mounts, fds, extra };
  }

  /**
   * The process to start for one landing command: refuses a command that does
   * not name its repository (v37), opens and checks every recorded directory
   * (v36; a mismatch throws WorktreeIdentityChanged and nothing starts), and
   * builds this command's namespace. `clearEnv` and `editMounts` exist for the
   * probe's control groups only.
   */
  spawnSpec(
    argv: readonly string[],
    env: Readonly<Record<string, string>>,
    cwd: string,
    opts: { readonly clearEnv?: boolean; readonly editMounts?: (m: MountSpec[]) => MountSpec[] } = {},
  ): SpawnSpec {
    if (env.GIT_DIR === undefined || env.GIT_DIR === '') {
      throw new TypeError('a landing git command must name its repository (GIT_DIR): the view never lets git discover one (6.6 v37)');
    }
    const { opened, problems } = openRecordedDirs(this.record, this.excluded);
    if (problems.length > 0) {
      closeOpened(opened);
      throw new WorktreeIdentityChanged(problems);
    }
    let extra: number[] = [];
    const closeAll = (): void => {
      closeOpened(opened);
      for (const fd of extra) {
        try {
          closeSync(fd);
        } catch {
          /* already closed */
        }
      }
    };
    try {
      (this.parent ?? this).afterIdentityCheck?.(argv);
      const ns = this.namespaceFor(opened);
      extra = ns.extra;
      let mounts = ns.mounts;
      if (opts.editMounts !== undefined) mounts = opts.editMounts(mounts);
      const args = [...bwrapArgv({ bwrapPath: this.bwrapPath, mounts, clearEnv: opts.clearEnv ?? true, env, cwd }), '--', ...argv];
      // bwrap itself starts in "/": the command's directory is set inside the namespace (--chdir).
      return { file: this.bwrapPath, args, env: { PATH: SYSTEM_PATH, LANG: FIXED_LANG }, cwd: '/', fds: ns.fds, release: closeAll };
    } catch (e) {
      closeAll();
      throw e;
    }
  }

  wrap(argv: readonly string[], env: Readonly<Record<string, string>>, cwd: string): SpawnSpec {
    return this.spawnSpec(argv, env, cwd);
  }

  /**
   * The receiving side's command (6.6 v47: the one generator). Receive-side
   * settings cannot travel by `git -c` on a local push, so they are on this
   * command line, which names no repository and no worktree (v38: the push
   * target is the common dir's absolute path). Common part: no fsmonitor, no
   * automatic gc, no submodule recursion, no replace objects (v48); then per class:
   * - zero: hooks from the empty read-only directory, denyCurrentBranch=refuse;
   * - one, the main worktree: hooks from this landing's hook directory (the
   *   program's push-to-checkout hook only), denyCurrentBranch=updateInstead;
   * - one, a linked worktree: the same plus core.bare=true.
   * The landing's token is added so recovery can find a stray receiver.
   */
  receivePackCommand(): string {
    const p = this.push;
    if (p === null) throw new Error('the receiving side exists only for a push binding (pushPlan)');
    const hooks = p.kind === 'zero' ? this.noHooksDir : this.checkoutHooksDir;
    if (hooks === null || (p.kind !== 'zero' && !existsSync(join(hooks, 'push-to-checkout')))) {
      throw new Error('a one-occupancy landing needs this landing\'s push-to-checkout hook (6.6 v46): installCheckoutHook first');
    }
    const c = (kv: string): string => `-c ${shellQuote(kv)}`;
    return [
      shellQuote(this.gitPath),
      c('core.fsmonitor=false'),
      c('receive.autogc=false'),
      c('submodule.recurse=false'),
      c('core.useReplaceRefs=false'),
      c(`core.hooksPath=${hooks}`),
      c(`receive.denyCurrentBranch=${p.kind === 'zero' ? 'refuse' : 'updateInstead'}`),
      ...(p.kind === 'linked' ? [c('core.bare=true')] : []),
      c(`mission-pipeline.landing=${this.token}`),
      'receive-pack',
    ].join(' ');
  }

  /**
   * The push of one landing, for one occupancy class (6.6 v47: the ONE generator
   * the landing and its tests run): the namespace (which linked git dirs exist,
   * v43-v45), the sending side's git arguments and the receiving side's command.
   * The sending side runs with GIT_DIR = the common dir (v38) and SafeGit's own
   * forced settings before these arguments; `--porcelain` only makes the result
   * parseable.
   */
  pushPlan(binding: PushBinding, o: { readonly deliveryRef: string; readonly targetRef: string; readonly base: string }): PushPlan {
    const view = this.forPush(binding);
    const receiver = view.receivePackCommand();
    return {
      binding,
      view,
      receiver,
      hooksDir: binding.kind === 'zero' ? this.noHooksDir : (this.checkoutHooksDir as string),
      senderArgs: [
        '-c',
        'core.hooksPath=/dev/null',
        '-c',
        'submodule.recurse=false',
        '-c',
        'core.useReplaceRefs=false',
        'push',
        '--porcelain',
        `--receive-pack=${receiver}`,
        this.commonDir,
        `${o.deliveryRef}:${o.targetRef}`,
        `--force-with-lease=${o.targetRef}:${o.base}`,
      ],
    };
  }

  dispose(): void {
    if (this.parent !== null) return; // a derived view shares the files of its parent
    try {
      chmodSync(this.dir, 0o755);
      chmodSync(this.homeDir, 0o755);
      chmodSync(join(this.dir, 'copies'), 0o755);
      if (this.checkoutHooksDir !== null) chmodSync(this.checkoutHooksDir, 0o755);
    } catch {
      /* already gone */
    }
    rmSync(this.dir, { recursive: true, force: true });
  }
}
