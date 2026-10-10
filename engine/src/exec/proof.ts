// Termination proofs on the supervisor side (design 7.1 "终止证明", 6.3 "证明对账入口").
//
//  - The proof file in the state directory is written atomically (tmp, fsync, rename, dir
//    fsync), so it either exists complete or not at all, into a directory chain whose every
//    entry was made durable first (each new directory and its parent synced, finding 12). It
//    is written BEFORE the unit's cgroup is deleted, and before any submission.
//  - Submission goes through a ProofSink (the ledger client plugs in here later). The
//    ledger deduplicates by launch id: the same proof submitted again returns the same
//    acknowledgement.
//  - Transient failure: back off 1 s doubling to 60 s, for at most 10 minutes; then leave
//    the file, raise an alert and exit. Deterministic rejection (launch mismatch,
//    malformed, a different proof already registered for the launch): mark the file
//    rejected, alert, never retry. Under a stop: one submission, then exit.
//  - The scheduler scans the state directory at every reconciliation and start, and
//    submits the files left behind (scanProofFiles, resubmitProofFile).

import { readFileSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { canonicalJson, sha256 } from '../common/hash.ts';
import { id, type LaunchId } from '../common/ids.ts';
import type { TerminationProofRecord } from '../common/records.ts';
import type { ExecAlert } from './alerts.ts';
import { REAL_DURABLE_OPS, ensureDirChainDurable, unlinkDurable, writeDurable, type DurableOps } from './durable.ts';

export { FileAlertSink, readAlerts, type AlertSink, type ExecAlert, type ExecAlertKind } from './alerts.ts';

// ---------------------------------------------------------------- validation

export class ProofFormatError extends Error {
  override readonly name = 'ProofFormatError';
}

function isObject(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

function exactKeys(o: Record<string, unknown>, keys: readonly string[], what: string): void {
  const got = Object.keys(o).sort();
  const want = [...keys].sort();
  if (got.length !== want.length || got.some((k, i) => k !== want[i])) {
    throw new ProofFormatError(`${what}: expected keys ${want.join(',')}, got ${got.join(',')}`);
  }
}

function count(x: unknown, what: string): number {
  if (typeof x !== 'number' || !Number.isSafeInteger(x) || x < 0) throw new ProofFormatError(`${what} is not a count`);
  return x;
}

export function parseLaunchId(x: unknown): LaunchId {
  if (typeof x !== 'string') throw new ProofFormatError('launch id is not a string');
  try {
    return id<LaunchId>(x);
  } catch (e) {
    throw new ProofFormatError((e as Error).message);
  }
}

/** Strict shape check of a TerminationProofRecord (the ledger's "内容不合格式"). */
export function validateTerminationProof(x: unknown): TerminationProofRecord {
  if (!isObject(x)) throw new ProofFormatError('proof is not an object');
  exactKeys(x, ['kind', 'launch', 'exit', 'controlOomKill', 'unitOomKill', 'unitOom'], 'proof');
  if (x['kind'] !== 'termination.proof') throw new ProofFormatError('proof kind is not termination.proof');
  const launch = parseLaunchId(x['launch']);
  const exit = x['exit'];
  if (!isObject(exit)) throw new ProofFormatError('exit is not an object');
  exactKeys(exit, ['code', 'signal'], 'exit');
  const code = exit['code'];
  const signal = exit['signal'];
  if (code !== null && (typeof code !== 'number' || !Number.isSafeInteger(code))) throw new ProofFormatError('bad exit code');
  if (signal !== null && (typeof signal !== 'string' || !/^SIG[A-Z0-9+-]+$/.test(signal))) {
    throw new ProofFormatError('bad exit signal');
  }
  if (code !== null && signal !== null) throw new ProofFormatError('exit has both a code and a signal');
  return {
    kind: 'termination.proof',
    launch,
    exit: { code, signal },
    controlOomKill: count(x['controlOomKill'], 'controlOomKill'),
    unitOomKill: count(x['unitOomKill'], 'unitOomKill'),
    unitOom: count(x['unitOom'], 'unitOom'),
  };
}

// ---------------------------------------------------------------- sinks

/** The three deterministic rejections of 7.1 step 4. Anything else is transient. */
export type ProofRejectionReason = 'launch-mismatch' | 'malformed' | 'conflicting-proof';

export type ProofSubmitResult =
  /** Registered as a fact; `duplicate` when the same proof was already registered (idempotent). */
  | { readonly kind: 'registered'; readonly ack: string; readonly duplicate: boolean }
  | { readonly kind: 'rejected'; readonly reason: ProofRejectionReason; readonly detail: string }
  /** Ledger temporarily unavailable (including 6.1 storage failure). Throwing means the same. */
  | { readonly kind: 'unavailable'; readonly detail: string };

/** Where proofs are registered (ledgerSink.ts: the ledger service). Must be idempotent per launch. */
export interface ProofSink {
  submit(proof: TerminationProofRecord): Promise<ProofSubmitResult>;
  /**
   * Optional (v35 7.1, 6.3): the launch's cleanup state, separate from the immutable proof:
   * 'pending' with what is still left, then 'done' (terminal). Idempotent per content.
   */
  recordCleanup?(launch: LaunchId, state: 'pending' | 'done', resources: readonly string[]): Promise<'recorded' | 'unavailable'>;
  /**
   * Optional (6.5): the host has ended, so any of its model requests still reserved are
   * settled at the reserved amount. Idempotent per launch. 'unavailable' leaves it to the
   * scheduler's reconciliation.
   */
  settleOpenSpend?(launch: LaunchId): Promise<'settled' | 'unavailable'>;
  /**
   * Optional (3.11, 3.9): delivers a system alert with its WI to the ledger (raiseAlert).
   * Idempotent per alert identity. 'unavailable' keeps only the local copy (alerts.ts).
   */
  raiseAlert?(alert: ExecAlert): Promise<'delivered' | 'unavailable'>;
  /** Releases the sink's connection. */
  close?(): void;
}

const REJECTION_REASONS: readonly string[] = ['launch-mismatch', 'malformed', 'conflicting-proof'];

/** A sink's answer is data from another component: anything unrecognized counts as "unavailable". */
export function normalizeSubmitResult(r: unknown): ProofSubmitResult {
  if (isObject(r)) {
    if (r['kind'] === 'registered' && typeof r['ack'] === 'string') {
      return { kind: 'registered', ack: r['ack'], duplicate: r['duplicate'] === true };
    }
    if (r['kind'] === 'rejected' && typeof r['reason'] === 'string' && REJECTION_REASONS.includes(r['reason'])) {
      return {
        kind: 'rejected',
        reason: r['reason'] as ProofRejectionReason,
        detail: typeof r['detail'] === 'string' ? r['detail'] : '',
      };
    }
    if (r['kind'] === 'unavailable') return { kind: 'unavailable', detail: String(r['detail'] ?? '') };
  }
  return { kind: 'unavailable', detail: `unrecognized sink answer ${JSON.stringify(r)}` };
}

/**
 * Reference semantics of proof registration on the ledger side (7.1 step 4), in memory:
 * registration is idempotent per launch id; the same content returns the same ack; a
 * proof for an unknown launch, a malformed proof, or different content for an already
 * registered launch is rejected deterministically. An existing final disposition never
 * blocks registration: registering a fact never decides acceptance.
 */
export class MemoryProofLedger implements ProofSink {
  private readonly known: ReadonlySet<string> | null;
  private readonly registered = new Map<string, { readonly canonical: string; readonly ack: string; readonly proof: TerminationProofRecord }>();

  /** `knownLaunches`: launch ids the ledger dispatched; omitted = every well-formed id is known. */
  constructor(opts: { readonly knownLaunches?: Iterable<LaunchId> } = {}) {
    this.known = opts.knownLaunches === undefined ? null : new Set<string>(opts.knownLaunches);
  }

  async submit(proof: unknown): Promise<ProofSubmitResult> {
    let p: TerminationProofRecord;
    try {
      p = validateTerminationProof(proof);
    } catch (e) {
      return { kind: 'rejected', reason: 'malformed', detail: (e as Error).message };
    }
    if (this.known !== null && !this.known.has(p.launch)) {
      return { kind: 'rejected', reason: 'launch-mismatch', detail: `no launch ${p.launch} was dispatched` };
    }
    const canonical = canonicalJson(p);
    const prev = this.registered.get(p.launch);
    if (prev !== undefined) {
      if (prev.canonical === canonical) return { kind: 'registered', ack: prev.ack, duplicate: true };
      return { kind: 'rejected', reason: 'conflicting-proof', detail: `launch ${p.launch} already has a different proof` };
    }
    const ack = `termination-proof:${p.launch}:${sha256(canonical).slice(0, 16)}`;
    this.registered.set(p.launch, { canonical, ack, proof: p });
    return { kind: 'registered', ack, duplicate: false };
  }

  get(launch: LaunchId): TerminationProofRecord | undefined {
    return this.registered.get(launch)?.proof;
  }

  get size(): number {
    return this.registered.size;
  }
}

// ---------------------------------------------------------------- proof files

export const PROOF_FILE_FORMAT = 'mp4.termination-proof-file.v1';

/** Facts about how the proof was produced. Not part of the ledger record. */
export interface ProofDiagnostics {
  readonly hostStarted: boolean;
  readonly spawnError: string | null;
  readonly hostExitedAt: string;
  readonly unitEmptyAt: string;
  /** Processes outlived the host and were killed with cgroup.kill before the proof. */
  readonly leftoversKilled: boolean;
  /** cgroup.events "populated" of the unit when the counters were read (must be false). */
  readonly populatedAtProof: boolean;
  /** A stop covered the unit before the proof was written. */
  readonly stopped: boolean;
  /** The service cgroup's own memory.events.local "oom": an ancestor of the unit hit ITS limit. */
  readonly serviceOom: number;
}

export interface ProofRejection {
  readonly reason: ProofRejectionReason;
  readonly detail: string;
  readonly at: string;
}

export interface ProofFile {
  readonly format: typeof PROOF_FILE_FORMAT;
  readonly status: 'pending' | 'rejected';
  readonly proof: TerminationProofRecord;
  readonly writtenAt: string;
  readonly supervisor: { readonly pid: number; readonly bootId: string };
  readonly diagnostics: ProofDiagnostics;
  readonly rejection: ProofRejection | null;
}

export function proofsDir(stateDir: string): string {
  return join(stateDir, 'proofs');
}

export function proofFilePath(stateDir: string, launch: LaunchId): string {
  return join(proofsDir(stateDir), `${launch}.json`);
}

/**
 * Writes the proof file atomically and durably; returns its path. The proofs directory chain
 * is made durable first (a no-op beyond two directory syncs when the supervisor prepared it).
 */
export function writeProofFile(stateDir: string, file: ProofFile, ops: DurableOps = REAL_DURABLE_OPS): string {
  ensureDirChainDurable(proofsDir(stateDir), stateDir, ops);
  const path = proofFilePath(stateDir, file.proof.launch);
  writeDurable(path, `${JSON.stringify(file, null, 2)}\n`, ops);
  return path;
}

function parseDiagnostics(x: unknown): ProofDiagnostics {
  if (!isObject(x)) throw new ProofFormatError('diagnostics is not an object');
  const bool = (k: string): boolean => {
    const v = x[k];
    if (typeof v !== 'boolean') throw new ProofFormatError(`diagnostics.${k} is not a boolean`);
    return v;
  };
  const str = (k: string): string => {
    const v = x[k];
    if (typeof v !== 'string') throw new ProofFormatError(`diagnostics.${k} is not a string`);
    return v;
  };
  const spawnError = x['spawnError'];
  if (spawnError !== null && typeof spawnError !== 'string') throw new ProofFormatError('diagnostics.spawnError');
  return {
    hostStarted: bool('hostStarted'),
    spawnError,
    hostExitedAt: str('hostExitedAt'),
    unitEmptyAt: str('unitEmptyAt'),
    leftoversKilled: bool('leftoversKilled'),
    populatedAtProof: bool('populatedAtProof'),
    stopped: bool('stopped'),
    serviceOom: typeof x['serviceOom'] === 'number' ? x['serviceOom'] : 0,
  };
}

export function parseProofFile(x: unknown): ProofFile {
  if (!isObject(x)) throw new ProofFormatError('proof file is not an object');
  if (x['format'] !== PROOF_FILE_FORMAT) throw new ProofFormatError(`unknown proof file format ${JSON.stringify(x['format'])}`);
  const status = x['status'];
  if (status !== 'pending' && status !== 'rejected') throw new ProofFormatError('bad proof file status');
  const proof = validateTerminationProof(x['proof']);
  const sup = x['supervisor'];
  if (!isObject(sup) || typeof sup['pid'] !== 'number' || typeof sup['bootId'] !== 'string') {
    throw new ProofFormatError('bad supervisor block');
  }
  const writtenAt = x['writtenAt'];
  if (typeof writtenAt !== 'string') throw new ProofFormatError('bad writtenAt');
  let rejection: ProofRejection | null = null;
  const rej = x['rejection'];
  if (rej !== null && rej !== undefined) {
    if (!isObject(rej) || typeof rej['reason'] !== 'string' || !REJECTION_REASONS.includes(rej['reason'])) {
      throw new ProofFormatError('bad rejection block');
    }
    rejection = {
      reason: rej['reason'] as ProofRejectionReason,
      detail: String(rej['detail'] ?? ''),
      at: String(rej['at'] ?? ''),
    };
  }
  if ((status === 'rejected') !== (rejection !== null)) throw new ProofFormatError('status and rejection disagree');
  return {
    format: PROOF_FILE_FORMAT,
    status,
    proof,
    writtenAt,
    supervisor: { pid: sup['pid'], bootId: sup['bootId'] },
    diagnostics: parseDiagnostics(x['diagnostics']),
    rejection,
  };
}

export function readProofFile(path: string): ProofFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    throw new ProofFormatError(`cannot read ${path}: ${(e as Error).message}`);
  }
  const file = parseProofFile(parsed);
  if (basename(path) !== `${file.proof.launch}.json`) {
    throw new ProofFormatError(`${path} holds the proof of launch ${file.proof.launch}`);
  }
  return file;
}

/** Marks a local proof file "rejected" with the reason (7.1 step 4); the proof itself is kept unchanged. */
export function markProofRejected(path: string, reason: ProofRejectionReason, detail: string, now: Date = new Date()): ProofFile {
  const file = readProofFile(path);
  const marked: ProofFile = { ...file, status: 'rejected', rejection: { reason, detail, at: now.toISOString() } };
  writeDurable(path, `${JSON.stringify(marked, null, 2)}\n`);
  return marked;
}

/** Removes a proof file once the ledger has registered it. */
export function removeProofFile(path: string): void {
  unlinkDurable(path);
}

export interface ProofFileEntry {
  readonly path: string;
  readonly file: ProofFile;
}

export interface ProofScan {
  /** Left behind unsubmitted: the scheduler submits these (6.3 "代为提交"). */
  readonly pending: readonly ProofFileEntry[];
  /** Deterministically rejected by the ledger: kept for inspection, never resubmitted. */
  readonly rejected: readonly ProofFileEntry[];
  readonly malformed: readonly { readonly path: string; readonly error: string }[];
}

/**
 * Lists the proof files in a state directory. Temporary files of an interrupted atomic
 * write (dot files) are not proofs and are ignored: a proof file exists complete or not at all.
 */
export function scanProofFiles(stateDir: string): ProofScan {
  const dir = proofsDir(stateDir);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { pending: [], rejected: [], malformed: [] };
    throw e;
  }
  const pending: ProofFileEntry[] = [];
  const rejected: ProofFileEntry[] = [];
  const malformed: { path: string; error: string }[] = [];
  for (const name of names.sort()) {
    if (name.startsWith('.') || !name.endsWith('.json')) continue;
    const path = join(dir, name);
    try {
      const file = readProofFile(path);
      (file.status === 'pending' ? pending : rejected).push({ path, file });
    } catch (e) {
      malformed.push({ path, error: (e as Error).message });
    }
  }
  return { pending, rejected, malformed };
}

// ---------------------------------------------------------------- submission with bounded retry

export interface RetryPolicy {
  readonly initialDelayMs: number;
  readonly maxDelayMs: number;
  /** No attempt is started later than this after the first one. */
  readonly totalMs: number;
  /** A sink call without an answer within this time counts as "unavailable". */
  readonly attemptTimeoutMs: number;
}

/** 7.1 step 3: 1 s doubling to 60 s, for at most 10 minutes. */
export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  initialDelayMs: 1_000,
  maxDelayMs: 60_000,
  totalMs: 600_000,
  attemptTimeoutMs: 30_000,
};

export interface Clock {
  now(): number;
  /** Resolves after `ms`, or early when `signal` aborts. */
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (ms, signal) =>
    new Promise<void>((resolve) => {
      if (signal?.aborted) {
        resolve();
        return;
      }
      const onAbort = (): void => {
        clearTimeout(t);
        resolve();
      };
      const t = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      signal?.addEventListener('abort', onAbort, { once: true });
    }),
};

export type SubmissionOutcome =
  | { readonly kind: 'registered'; readonly ack: string; readonly duplicate: boolean; readonly attempts: number }
  | { readonly kind: 'rejected'; readonly reason: ProofRejectionReason; readonly detail: string; readonly attempts: number }
  /** Retries exhausted (10 minutes): leave the file, alert, exit. */
  | { readonly kind: 'gave-up'; readonly attempts: number; readonly lastError: string }
  /** A stop covered the unit: the single submission failed; the file stays for the scheduler. */
  | { readonly kind: 'stopped'; readonly attempts: number; readonly lastError: string };

export interface SubmitOptions {
  readonly policy?: RetryPolicy;
  readonly clock?: Clock;
  /** Aborted when a stop covers the unit. */
  readonly stop?: AbortSignal;
  readonly onAttempt?: (attempt: number, at: number) => void;
}

async function attemptOnce(sink: ProofSink, proof: TerminationProofRecord, timeoutMs: number): Promise<ProofSubmitResult> {
  let timer: NodeJS.Timeout | undefined;
  // Not unref'd: a sink that hangs without holding any handle must still time out.
  const timeout = new Promise<ProofSubmitResult>((resolve) => {
    timer = setTimeout(() => resolve({ kind: 'unavailable', detail: `no answer within ${timeoutMs} ms` }), timeoutMs);
  });
  try {
    return await Promise.race([
      sink.submit(proof).then(normalizeSubmitResult, (e: unknown) => ({
        kind: 'unavailable' as const,
        detail: e instanceof Error ? e.message : String(e),
      })),
      timeout,
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Submits until registered or deterministically rejected, backing off between transient
 * failures, for at most `policy.totalMs`. When a stop is in force at the start, exactly one
 * attempt is made; when it arrives during a back-off, one last attempt is made at once.
 */
export async function submitProofWithRetry(
  proof: TerminationProofRecord,
  sink: ProofSink,
  opts: SubmitOptions = {},
): Promise<SubmissionOutcome> {
  const policy = opts.policy ?? DEFAULT_RETRY_POLICY;
  const clock = opts.clock ?? systemClock;
  const start = clock.now();
  let delay = policy.initialDelayMs;
  let attempts = 0;
  let lastAttempt = opts.stop?.aborted ?? false;
  for (;;) {
    attempts++;
    opts.onAttempt?.(attempts, clock.now());
    const r = await attemptOnce(sink, proof, policy.attemptTimeoutMs);
    if (r.kind === 'registered') return { kind: 'registered', ack: r.ack, duplicate: r.duplicate, attempts };
    if (r.kind === 'rejected') return { kind: 'rejected', reason: r.reason, detail: r.detail, attempts };
    if (lastAttempt || opts.stop?.aborted) return { kind: 'stopped', attempts, lastError: r.detail };
    if (clock.now() + delay - start > policy.totalMs) return { kind: 'gave-up', attempts, lastError: r.detail };
    await clock.sleep(delay, opts.stop);
    if (opts.stop?.aborted) lastAttempt = true;
    delay = Math.min(delay * 2, policy.maxDelayMs);
  }
}

/**
 * Scheduler side (6.3 entry step 2): submit one proof file left in the state directory.
 * One attempt; registered removes the file, a deterministic rejection marks it. A transient
 * failure leaves it for the next reconciliation.
 */
export async function resubmitProofFile(
  entry: ProofFileEntry,
  sink: ProofSink,
  opts: { readonly attemptTimeoutMs?: number } = {},
): Promise<SubmissionOutcome> {
  const out = await submitProofWithRetry(entry.file.proof, sink, {
    policy: { ...DEFAULT_RETRY_POLICY, totalMs: 0, attemptTimeoutMs: opts.attemptTimeoutMs ?? DEFAULT_RETRY_POLICY.attemptTimeoutMs },
  });
  if (out.kind === 'registered') removeProofFile(entry.path);
  else if (out.kind === 'rejected') markProofRejected(entry.path, out.reason, out.detail);
  return out;
}
