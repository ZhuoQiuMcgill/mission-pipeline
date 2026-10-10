// Program refs (design 6.1 "git：程序只创建自己命名空间里的引用", 6.6 step 6).
//
// - The program only ever CREATES refs, and only under refs/mission-pipeline/.
//   It never updates refs/heads/, a worktree or an index.
// - Creation is a compare-and-swap from "must not exist", touches one ref, is
//   fsynced (objects and references) and never follows a link (code review r1
//   #2: `update-ref` without --no-deref creates the target of a dangling symref
//   stored under the program's name, and a symlinked directory such as
//   refs/mission-pipeline -> heads makes even --no-deref create a branch):
//     files backend   -> the program's own writer process (refWriter.ts): every
//                        namespace directory opened relative to its parent with
//                        O_NOFOLLOW, git's own lock protocol, link(2), and a
//                        re-check that removes its own file again if a directory
//                        was swapped during the write (unsafe namespace, WI-20);
//     anything else    -> no ref at all (v50, v51, repoFormat.ts): a reftable
//                        repository, or one with extensions the program does not
//                        understand, is refused before anything is written
//                        (WI-13); no delivery is made there.
// - Recovery classifies what it finds (6.1 table):
//     ref == B                 -> done: record completion
//     absent                   -> not done: re-authorize (re-check stops) before retrying
//     absent, lock left behind -> once every writer of the intent is confirmed gone, the
//                                 lock is removed ONLY if it is the very file the program's
//                                 writer created (its identity is in the write record,
//                                 durable before anything was written; review r2 #3);
//                                 any other lock (another git process, or one the program
//                                 cannot prove is its own) is kept: the intent stays
//                                 pending, WI-14, its owner finishes or removes it
//     absent, but the writer linked the ref into a directory that was moved out of the
//                                 namespace and then crashed (review r2 #2) -> found by
//                                 the recorded directory identity: never redone, never
//                                 deleted, reported with its path (WI-20)
//     exists, != B             -> tampered: never redo, never record completion; alert the user
//     a symlink or a file where the namespace needs a directory -> tampered (unsafe namespace)
//
// The intent records the writer's pid, start time and boot id; the writer's
// command line also carries the intent token, so a writer whose identity never
// reached the ledger (crash right after spawn) is still found.
//
// Ref names: ids may contain characters a ref name cannot (ids.ts allows ':'),
// so each component is percent-encoded over the alphabet [A-Za-z0-9_-].

import { existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256 } from '../common/hash.ts';
import type { Brand, MissionId, OpId, GitOid } from '../common/ids.ts';
import { batchCheck, gitOid, repoArgs, type RepoLayout } from './objects.ts';
import {
  findEscapedRef,
  lockIsRecorded,
  readRefWriteRecord,
  refNamespaceProblem,
  unlinkLooseRefLock,
  type RefWriteJob,
  type RefWriteRecord,
  type RefWriteResult,
} from './refWriter.ts';
import { repositoryFormat } from './repoFormat.ts';
import {
  findProcessesByToken,
  FIXED_LANG,
  isProcessAlive,
  killProcess,
  SYSTEM_PATH,
  type GitResult,
  type GitSandbox,
  type ProcessIdentity,
  type SafeGit,
} from './safeGit.ts';

export const PROGRAM_REF_NAMESPACE = 'refs/mission-pipeline/';

export type ProgramRefName = Brand<string, 'ProgramRefName'>;

export function encodeRefComponent(s: string): string {
  if (s.length === 0) throw new TypeError('empty ref component');
  let out = '';
  for (const byte of Buffer.from(s, 'utf8')) {
    const ch = String.fromCharCode(byte);
    out += /^[A-Za-z0-9_-]$/.test(ch) ? ch : '%' + byte.toString(16).toUpperCase().padStart(2, '0');
  }
  return out;
}

export function programRef(...components: readonly string[]): ProgramRefName {
  if (components.length === 0) throw new TypeError('a program ref needs at least one component');
  return (PROGRAM_REF_NAMESPACE + components.map(encodeRefComponent).join('/')) as ProgramRefName;
}

/** refs/mission-pipeline/delivered/<mission>/<op> (6.1, 6.6 step 6). */
export function deliveryRef(mission: MissionId, op: OpId): ProgramRefName {
  return programRef('delivered', mission, op);
}

/** Accepts only names this module could have produced. */
export function asProgramRef(name: string): ProgramRefName {
  if (!name.startsWith(PROGRAM_REF_NAMESPACE)) throw new TypeError(`not a program ref: ${name}`);
  const rest = name.slice(PROGRAM_REF_NAMESPACE.length).split('/');
  if (rest.length === 0 || rest.some((c) => !/^(?:[A-Za-z0-9_-]|%[0-9A-F]{2})+$/.test(c))) {
    throw new TypeError(`program ref has a component outside the encoded alphabet: ${name}`);
  }
  return name as ProgramRefName;
}

export type RefState =
  | { readonly kind: 'absent' }
  | { readonly kind: 'direct'; readonly oid: GitOid }
  | { readonly kind: 'symbolic'; readonly target: string }
  /** Something is stored under the name but git cannot read it as a ref. */
  | { readonly kind: 'unreadable'; readonly detail: string }
  /**
   * A symlink or a file where the program's namespace needs a directory (files
   * backend): whatever git reads under the name may be another ref (WI-20).
   */
  | { readonly kind: 'unsafe-namespace'; readonly detail: string };

async function refFormat(git: SafeGit, repo: RepoLayout): Promise<string> {
  return git.text([...repoArgs(repo), 'rev-parse', '--show-ref-format'], { cwd: repo.commonDir });
}

export async function readRefState(git: SafeGit, repo: RepoLayout, name: ProgramRefName): Promise<RefState> {
  const files = (await refFormat(git, repo)) === 'files';
  if (files) {
    // Before anything is read through the namespace: a link in it would make git read another ref.
    const problem = refNamespaceProblem(repo.commonDir, name);
    if (problem !== null) return { kind: 'unsafe-namespace', detail: problem };
  }
  const r = await git.ok([...repoArgs(repo), 'for-each-ref', '--format=%(refname)%00%(objectname)%00%(symref)', name], {
    cwd: repo.commonDir,
  });
  for (const line of r.stdout.toString('utf8').split('\n')) {
    const [refname, oid, symref] = line.split('\0');
    if (refname !== name) continue;
    if (symref !== undefined && symref !== '') return { kind: 'symbolic', target: symref };
    if (oid !== undefined && oid !== '') return { kind: 'direct', oid: gitOid(oid) };
  }
  const sym = await git.run([...repoArgs(repo), 'symbolic-ref', '-q', name], { cwd: repo.commonDir });
  if (sym.code === 0) return { kind: 'symbolic', target: sym.stdout.toString('utf8').trim() };
  if (files && existsSync(join(repo.commonDir, name))) {
    return { kind: 'unreadable', detail: 'a loose ref file exists but git does not read it as a ref' };
  }
  return { kind: 'absent' };
}

/**
 * A lock left by a writer that was killed. Null when there is none. Files
 * backend: `<name>.lock` in the program's namespace (null when the namespace
 * is unsafe: the path would not be the program's). Reftable: the repository-wide
 * `tables.list.lock`, reported only; removeStaleRefLock never removes it.
 */
export async function staleRefLock(git: SafeGit, repo: RepoLayout, name: ProgramRefName): Promise<string | null> {
  const fmt = await refFormat(git, repo);
  if (fmt === 'files' && refNamespaceProblem(repo.commonDir, name) !== null) return null;
  const lock = fmt === 'files' ? join(repo.commonDir, `${name}.lock`) : join(repo.commonDir, 'reftable', 'tables.list.lock');
  return existsSync(lock) ? lock : null;
}

/**
 * Removes the stale lock of `name`, only when it is the lock the program's
 * writer created according to its write record (review r2 #3). The caller must
 * first have confirmed that the writer is gone (6.1); `writer` is re-checked
 * here. Files backend only, through the namespace without following a link.
 * Returns false (nothing removed) when there is no record, the lock is not the
 * recorded file, or there is no lock.
 */
export async function removeStaleRefLock(
  git: SafeGit,
  repo: RepoLayout,
  name: ProgramRefName,
  writer: ProcessIdentity | null,
  record: RefWriteRecord | null = null,
): Promise<boolean> {
  if (writer !== null && isProcessAlive(writer)) throw new Error('the writer of this ref is still running');
  if ((await refFormat(git, repo)) !== 'files') return false;
  if (!lockIsRecorded(repo.commonDir, name, record)) {
    if (refNamespaceProblem(repo.commonDir, name) !== null) throw new Error(`refusing to remove a lock through an unsafe namespace: ${refNamespaceProblem(repo.commonDir, name)}`);
    return false;
  }
  return unlinkLooseRefLock(repo.commonDir, name, (record as RefWriteRecord).lock);
}

/** Where the writer of `name` for intent `token` keeps its write record (review r2 #2, #3). */
export function refWriteRecordPath(recordDir: string, token: string | null, name: ProgramRefName): string {
  return join(recordDir, `${sha256(`${token ?? ''}\0${name}`).slice(0, 40)}.json`);
}

export type RefCreation =
  | { readonly kind: 'created'; readonly result: GitResult }
  /** The ref already points at the target: the action had happened (record completion). */
  | { readonly kind: 'exists-same' }
  /** The program namespace was changed from outside: system alert, user decides (6.1). */
  | { readonly kind: 'exists-different'; readonly state: RefState }
  /** Not created and the ref is absent, e.g. a stale lock from a killed writer. */
  | { readonly kind: 'failed'; readonly result: GitResult; readonly staleLock: string | null }
  /**
   * A symlink or a file in the namespace's directory chain, before the write or
   * swapped in during it (WI-20). `removedOwnRef`: the writer had created the
   * ref and removed it again because the directory it wrote into was no longer
   * the namespace's. Nothing the program created is left outside its namespace.
   */
  | { readonly kind: 'unsafe-namespace'; readonly detail: string; readonly removedOwnRef: boolean }
  /**
   * v50 (WI-13): a reftable repository, or extensions the program does not
   * understand; review r2 #4: a filesystem without hard links. No ref is ever
   * created there.
   */
  | { readonly kind: 'unsupported-repository'; readonly format: 'reftable' | 'unsupported' | 'no-hard-links'; readonly detail: string };

export interface CreateRefOptions {
  readonly timeoutMs?: number;
  /** Called with the writer's identity right after it starts: record it in the intent (6.1). */
  readonly onSpawn?: (p: ProcessIdentity) => void;
  /** The intent's token, put on the writer's command line so recovery can find a writer whose identity was never recorded. */
  readonly intentToken?: string;
  /**
   * The program's state directory for write records (review r2 #2, #3). Without
   * it, recovery can never prove a leftover lock is the program's: it is kept.
   */
  readonly recordDir?: string;
  /** Tests only (files backend): the writer stops at these points until `<file>.go-<point>` exists. */
  readonly testPause?: RefWriteJob['pause'];
  /** Tests only: link(2) fails with this error code in the writer. */
  readonly testFailLink?: string;
}

const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;

/** The writer process (refWriter-main.ts). */
export const REF_WRITER_MAIN = fileURLToPath(new URL('./refWriter-main.ts', import.meta.url));

/**
 * Runs the program's ref writer through SafeGit's process machinery (deadline,
 * process group kill, identity, onSpawn) by standing in for the git process: the
 * spawned program is the writer, not git, and the intent token is its argument.
 */
function refWriterProcess(token: string | null): GitSandbox {
  return {
    gitEnvironment: () => ({ PATH: SYSTEM_PATH, LANG: FIXED_LANG }),
    wrap: (_argv, _env, cwd) => ({
      file: process.execPath,
      args: ['--experimental-strip-types', '--disable-warning=ExperimentalWarning', REF_WRITER_MAIN, ...(token !== null ? [`mission-pipeline.intent=${token}`] : [])],
      env: { PATH: SYSTEM_PATH, LANG: FIXED_LANG },
      cwd,
    }),
  };
}

function writerResult(r: GitResult): RefWriteResult | { readonly kind: 'error'; readonly detail: string } | null {
  const line = r.stdout.toString('utf8').trim().split('\n').pop() ?? '';
  try {
    return JSON.parse(line) as RefWriteResult | { kind: 'error'; detail: string };
  } catch {
    return null;
  }
}

/**
 * Creates `name` -> `target` only if `name` does not exist. A GitTimeoutError
 * propagates: the ledger records "result pending verification" and calls
 * classifyProgramRef once the process has exited (6.1).
 */
export async function createProgramRef(
  git: SafeGit,
  repo: RepoLayout,
  name: ProgramRefName,
  target: GitOid,
  opts: CreateRefOptions = {},
): Promise<RefCreation> {
  asProgramRef(name);
  const fmt = await git.run([...repoArgs(repo), 'check-ref-format', name], { cwd: repo.commonDir });
  if (fmt.code !== 0) throw new TypeError(`invalid ref name ${name}`);
  const info = (await batchCheck(git, repo, [target])).get(target);
  if (info === null || info === undefined || info.type !== 'commit') throw new TypeError(`${target} is not a commit in this repository`);
  if (opts.intentToken !== undefined && !TOKEN.test(opts.intentToken)) throw new TypeError(`bad intent token ${opts.intentToken}`);
  const common = {
    cwd: repo.commonDir,
    config: [
      ['core.fsync', 'committed'],
      ['core.fsyncMethod', 'fsync'],
      ...(opts.intentToken !== undefined ? ([['mission-pipeline.intent', opts.intentToken]] as const) : []),
    ] as const,
    ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
    ...(opts.onSpawn !== undefined ? { onSpawn: opts.onSpawn } : {}),
  };
  // v50: only the files ref backend with understood extensions; otherwise no ref at all (WI-13).
  const format = await repositoryFormat(git, repo);
  if (format.kind === 'reftable') {
    return { kind: 'unsupported-repository', format: 'reftable', detail: 'the repository stores refs in reftable: the program creates no ref there' };
  }
  if (format.kind === 'unsupported') return { kind: 'unsupported-repository', format: 'unsupported', detail: format.detail };
  // Refused before anything starts when the namespace already holds a link (review r1 #2).
  const problem = refNamespaceProblem(repo.commonDir, name);
  if (problem !== null) return { kind: 'unsafe-namespace', detail: problem, removedOwnRef: false };
  let record: string | undefined;
  if (opts.recordDir !== undefined) {
    mkdirSync(opts.recordDir, { recursive: true });
    record = refWriteRecordPath(opts.recordDir, opts.intentToken ?? null, name);
  }
  const job: RefWriteJob = {
    commonDir: repo.commonDir,
    name,
    target,
    fsync: true,
    ...(record !== undefined ? { record } : {}),
    ...(opts.testPause !== undefined ? { pause: opts.testPause } : {}),
    ...(opts.testFailLink !== undefined ? { testFailLink: opts.testFailLink } : {}),
  };
  const r: GitResult = await git.run(['mission-pipeline-ref-writer', name], { ...common, sandbox: refWriterProcess(opts.intentToken ?? null), input: JSON.stringify(job) });
  const out = writerResult(r);
  if (out !== null && out.kind === 'unsafe-namespace') return { kind: 'unsafe-namespace', detail: out.detail, removedOwnRef: out.removedOwnRef };
  if (out !== null && out.kind === 'unsupported-filesystem') return { kind: 'unsupported-repository', format: 'no-hard-links', detail: out.detail };
  const state = await readRefState(git, repo, name);
  if (state.kind === 'unsafe-namespace') return { kind: 'unsafe-namespace', detail: state.detail, removedOwnRef: false };
  if (r.code === 0) {
    if (state.kind === 'direct' && state.oid === target) return { kind: 'created', result: r };
    return { kind: 'exists-different', state };
  }
  if (state.kind === 'direct' && state.oid === target) return { kind: 'exists-same' };
  if (state.kind !== 'absent') return { kind: 'exists-different', state };
  return { kind: 'failed', result: r, staleLock: await staleRefLock(git, repo, name) };
}

export type RefRecovery =
  | { readonly kind: 'done' }
  | { readonly kind: 'not-done'; readonly staleLock: string | null }
  | { readonly kind: 'tampered'; readonly state: RefState };

/**
 * What the intent of a ref creation recorded (6.1): the writer's identity, if it
 * was recorded, the token on its command line, and where its write record is
 * kept (review r2 #2, #3).
 */
export interface RefIntent {
  readonly token: string;
  readonly writer: ProcessIdentity | null;
  readonly recordDir?: string;
}

export type RefRecoveryAction =
  | { readonly kind: 'done' }
  /** Absent (a stale lock of the program's writer, if any, was removed after it was confirmed gone): re-authorize, then create. */
  | { readonly kind: 'not-done'; readonly removedLock: string | null }
  | { readonly kind: 'tampered'; readonly state: RefState }
  /** A writer of this intent is still running: wait, or recover again with `kill`. */
  | { readonly kind: 'writer-running'; readonly processes: readonly ProcessIdentity[] }
  /**
   * review r2 #3: absent, and a lock the program cannot prove is its own holds the
   * name (another git process, or a writer that died before recording it): kept;
   * the intent stays pending (WI-14) until its owner finishes or removes it.
   */
  | { readonly kind: 'lock-not-ours'; readonly lock: string }
  /**
   * review r2 #2: absent from the namespace, but the program's writer linked it
   * into a directory that was moved out of the namespace and then died: never
   * redone, never deleted; reported with where it is (WI-20).
   */
  | { readonly kind: 'escaped'; readonly paths: readonly string[] };

async function waitGone(procs: readonly ProcessIdentity[], ms: number): Promise<ProcessIdentity[]> {
  const deadline = Date.now() + ms;
  for (;;) {
    const alive = procs.filter((p) => isProcessAlive(p));
    if (alive.length === 0 || Date.now() >= deadline) return alive;
    await new Promise((r) => setTimeout(r, 25));
  }
}

/**
 * The full 6.1 recovery for a program ref, including the v34 row for a lock left
 * by a killed writer. A lock is removed only after every writer of this intent
 * (by recorded identity, or by the token on its command line) is confirmed gone.
 */
export async function recoverProgramRef(
  git: SafeGit,
  repo: RepoLayout,
  name: ProgramRefName,
  expected: GitOid,
  intent: RefIntent,
  opts: { readonly waitMs?: number; readonly kill?: boolean } = {},
): Promise<RefRecoveryAction> {
  if (!TOKEN.test(intent.token)) throw new TypeError(`bad intent token ${intent.token}`);
  const writers = new Map<number, ProcessIdentity>();
  if (intent.writer !== null && isProcessAlive(intent.writer)) writers.set(intent.writer.pid, intent.writer);
  for (const p of findProcessesByToken(`mission-pipeline.intent=${intent.token}`)) writers.set(p.pid, p);
  if (writers.size > 0) {
    let alive = await waitGone([...writers.values()], opts.waitMs ?? 0);
    if (alive.length > 0 && opts.kill === true) {
      for (const p of alive) killProcess(p);
      alive = await waitGone(alive, 5_000);
    }
    if (alive.length > 0) return { kind: 'writer-running', processes: alive };
  }
  // Every writer is gone: what is on disk now is final.
  const recordPath = intent.recordDir !== undefined ? refWriteRecordPath(intent.recordDir, intent.token, name) : null;
  const record = recordPath !== null ? readRefWriteRecord(recordPath) : null;
  const forget = (): void => {
    if (recordPath === null) return;
    try {
      unlinkSync(recordPath);
    } catch {
      /* gone */
    }
  };
  const rec = await classifyProgramRef(git, repo, name, expected);
  if (rec.kind === 'done') {
    // A writer killed between linking the ref and removing its lock leaves both: removed only if it is that writer's own
    // (another lock may belong to a git process running now: it stays).
    const lock = await staleRefLock(git, repo, name);
    if (lock === null || (await removeStaleRefLock(git, repo, name, intent.writer, record))) forget();
    return rec;
  }
  if (rec.kind !== 'not-done') return rec;
  // review r2 #2: did the writer link it into a directory that was moved out of the namespace?
  if (record !== null && record.name === name) {
    const escaped = findEscapedRef(repo.commonDir, record);
    if (escaped.length > 0) return { kind: 'escaped', paths: escaped };
  }
  if (rec.staleLock === null) {
    forget();
    return { kind: 'not-done', removedLock: null };
  }
  // review r2 #3: a lock is removed only when it is provably the program's writer's own.
  if (!(await removeStaleRefLock(git, repo, name, intent.writer, record))) return { kind: 'lock-not-ours', lock: rec.staleLock };
  forget();
  return { kind: 'not-done', removedLock: rec.staleLock };
}

/** The 6.1 recovery table, read with the ref in its current state. */
export async function classifyProgramRef(
  git: SafeGit,
  repo: RepoLayout,
  name: ProgramRefName,
  expected: GitOid,
): Promise<RefRecovery> {
  const state = await readRefState(git, repo, name);
  if (state.kind === 'direct' && state.oid === expected) return { kind: 'done' };
  if (state.kind === 'absent') return { kind: 'not-done', staleLock: await staleRefLock(git, repo, name) };
  return { kind: 'tampered', state };
}
