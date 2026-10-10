// Exception notices of the execution layer and the seat host (design 3.11 "例外处置：PM 的作业
// 指导书", 3.9, 6.1 "系统告警"; code review r1 finding 15).
//
// Every exception the program emits names its PM work instruction (WI) and carries:
//   - the trigger facts (what happened, how the program found it, the evidence);
//   - the default action the program has ALREADY taken (it only ever stops the one affected
//     action, and can be revisited by the PM).
// Delivery: a local copy first (<stateDir>/alerts.jsonl, durable; the fallback when the ledger
// is unavailable), then the ledger's raiseAlert (an alert record with its `wi` field; the
// scheduler copies committed alerts to the control plane, where the PM's monitor reads them,
// 3.9). Alert identity is derived from (source, category, key), so raising the same alert
// again is the same ledger operation. Alerts whose ledger delivery failed are listed by
// undeliveredAlerts() so the scheduler can carry them over (deliverPendingAlerts).
//
// WI numbering: design v42 (WI-09 budget, and a seat's model not available, WI-10 resource block, WI-14 cleanup / processes that
// will not end, WI-15 attempt failure, WI-17 async evidence and recovery state, WI-18 startup
// self-check, WI-20 consistency anomaly); WI-12 (storage fault, the ledger unavailable) as in v41.

import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { appendLineDurable } from '../common/fsx.ts';
import { canonicalJson } from '../common/hash.ts';
import { id, type AlertId, type ContentHash, type LaunchId } from '../common/ids.ts';
import type { ContentStore } from '../ledger/content.ts';

export type WorkInstruction = 'WI-09' | 'WI-10' | 'WI-12' | 'WI-14' | 'WI-15' | 'WI-17' | 'WI-18' | 'WI-20';

/** Every exception this layer can emit, each with exactly one WI (3.11 principle 5: no exception without a WI). */
export const EXEC_ALERT_WI = {
  // ---- unit supervisor and cleanup (exec)
  /** Teardown left resources; retried by the scheduler with back-off; they stay counted. */
  'cleanup-pending': 'WI-14',
  /** A cleanup resource's recorded identity no longer matches what is on disk: refused, kept pending. */
  'cleanup-identity-mismatch': 'WI-20',
  /** Processes stay in the unit after cgroup.kill (6.4 "无法结束的进程"). */
  'unkillable-processes': 'WI-14',
  /** The unit subtree could not be destroyed after a supervisor error. */
  'unit-cleanup-failed': 'WI-14',
  /** The cleanup state could not be recorded in the ledger: the local copy is kept for the scheduler. */
  'cleanup-unrecorded': 'WI-12',
  /** The dead host's open spend reservations could not be settled: left to reconciliation (still counted). */
  'spend-settlement-unavailable': 'WI-12',
  /** The proof could not be registered within 10 minutes (ledger unavailable): the file is left. */
  'proof-submission-exhausted': 'WI-12',
  /** The ledger deterministically rejected the proof (launch mismatch, malformed, conflicting proof). */
  'proof-rejected': 'WI-20',
  /** The local proof file could not be written: the proof is submitted directly. */
  'proof-write-failed': 'WI-20',
  /** The proof sink module could not be loaded: the proof file is left for the scheduler. */
  'proof-sink-unloadable': 'WI-20',
  /** The supervisor itself failed: the attempt has no proof from it (6.3 reconciliation entry). */
  'supervisor-error': 'WI-15',
  // ---- seat host (seat)
  /** The metering proxy refused a request at the spend limit and the seat was ended (6.5). */
  'spend-refused': 'WI-09',
  /**
   * The seat's configured model is not available to this login (retired, or not in its plan):
   * Claude Code refused it, or the model service answered 404 not_found_error. The attempt ends
   * as an environment failure; retries fail the same way until the seat's model changes.
   */
  'model-unavailable': 'WI-09',
  /** A large-disk unit cannot run here (no fuse2fs, no prepared image): resource block (7.1, 6.5). */
  'area-unavailable': 'WI-10',
  /** The attempt ended as an environment failure, a seat failure, or over its resources. */
  'attempt-failed': 'WI-15',
  /** An async evidence request was refused (session state over the recovery cap, or not storable). */
  'async-evidence-refused': 'WI-17',
  /** The recovery state of a resumed seat is missing or unusable: a new session from the ledger (6.2). */
  'recovery-state-degraded': 'WI-17',
  /** The final session state outgrew the recovery cap: the state saved at acceptance is kept. */
  'recovery-state-fallback': 'WI-17',
  /** No passing startup self-check for these versions: the seat was not started (9.3). */
  'selfcheck-failed': 'WI-18',
  /** A recorded toolchain tree failed its check before the mount (a link now, or holding credentials): left out of the sandbox. */
  'toolchain-unavailable': 'WI-18',
  /** The card's materials do not match the content store (missing, corrupt, paged otherwise): the seat was not started. */
  'card-materials-invalid': 'WI-20',
  /**
   * A reading seat's fetch_url was refused: an address (or a redirect) outside the card's
   * allowance, a non-public address, or no ledger authorization. The round goes on.
   * The design has no dedicated WI for it yet: WI-15's options (change the card, restart) apply.
   */
  'web-fetch-refused': 'WI-15',
} as const satisfies Readonly<Record<string, WorkInstruction>>;

export type ExecAlertKind = keyof typeof EXEC_ALERT_WI;

/** A system alert (6.1 "系统告警") raised by the execution layer or a seat host. */
export interface ExecAlert {
  readonly at: string;
  readonly launch: LaunchId | null;
  readonly kind: ExecAlertKind;
  /** The PM work instruction (3.11). */
  readonly wi: WorkInstruction;
  /** One-line summary (also on stderr). */
  readonly detail: string;
  /** The trigger: the facts and the evidence, structured. */
  readonly trigger: Readonly<Record<string, unknown>>;
  /** The default action already taken. */
  readonly defaultAction: string;
  /** What makes this occurrence its own alert (default: the launch). */
  readonly key?: string;
}

export function execAlert(
  kind: ExecAlertKind,
  launch: LaunchId | null,
  detail: string,
  trigger: Readonly<Record<string, unknown>>,
  defaultAction: string,
  key?: string,
): ExecAlert {
  return { at: new Date().toISOString(), launch, kind, wi: EXEC_ALERT_WI[kind], detail, trigger, defaultAction, ...(key !== undefined ? { key } : {}) };
}

/** Destination of system alerts. A promise is awaited by callers that must not exit before delivery. */
export interface AlertSink {
  alert(a: ExecAlert): void | Promise<void>;
}

/** The alert's identity in the ledger: stable for (source, category, key). */
export function alertIdentity(source: string, a: Pick<ExecAlert, 'kind' | 'launch' | 'key'>): AlertId {
  const key = a.key ?? a.launch ?? '-';
  const h = createHash('sha256').update(`${source}\0${a.kind}\0${key}`).digest('hex').slice(0, 20);
  return id<AlertId>(`${source}.${a.kind}.${h}`);
}

/**
 * The alert body stored in the content store (what the PM reads). Deterministic for the
 * occurrence (no timestamp: the ledger records when it was committed), so raising the same
 * alert again after a crash or a lost answer is the same operation.
 */
export function alertBody(source: string, a: ExecAlert): string {
  return canonicalJson({
    format: 'mp4.exec-alert.v1',
    source,
    category: a.kind,
    wi: a.wi,
    launch: a.launch,
    key: a.key ?? a.launch ?? null,
    trigger: a.trigger,
    defaultAction: a.defaultAction,
    detail: a.detail,
  });
}

/** What the ledger offers for alerts (LedgerClient.call('raiseAlert', ...) fits). */
export interface AlertLedger {
  call(method: 'raiseAlert', params: { op: string; alert: AlertId; category: string; wi: string; body: ContentHash }): Promise<unknown>;
}

/**
 * Delivers alerts to the ledger (raiseAlert with the WI); throws when the ledger does not take
 * it. An alert whose identity the ledger already holds (OP_CONFLICT: the same occurrence raised
 * earlier with other facts, e.g. a second launch refused by the same failed self-check) counts as
 * delivered: the PM has it once.
 */
export async function deliverToLedger(ledger: AlertLedger, content: ContentStore, source: string, a: ExecAlert): Promise<AlertId> {
  const alert = alertIdentity(source, a);
  const body = content.put(alertBody(source, a));
  try {
    await ledger.call('raiseAlert', { op: `alert:${alert}`, alert, category: a.kind, wi: a.wi, body });
  } catch (e) {
    if ((e as { code?: unknown }).code !== 'OP_CONFLICT') throw e;
  }
  return alert;
}

// ---------------------------------------------------------------- local copies (fallback)

export function alertsPath(stateDir: string): string {
  return join(stateDir, 'alerts.jsonl');
}

function deliveredPath(stateDir: string): string {
  return join(stateDir, 'alerts-delivered.jsonl');
}

function appendDurably(path: string, line: string): void {
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    appendLineDurable(path, line);
  } catch (e) {
    try {
      appendFileSync(path, `${line}\n`);
    } catch {
      process.stderr.write(`[alert] could not persist: ${(e as Error).message}\n`);
    }
  }
}

/** Appends alerts durably to `<stateDir>/alerts.jsonl` (and mirrors them to stderr). */
export class FileAlertSink implements AlertSink {
  readonly path: string;
  private readonly source: string;

  constructor(stateDir: string, source = 'exec') {
    this.path = alertsPath(stateDir);
    this.source = source;
  }

  alert(a: ExecAlert): void {
    process.stderr.write(`[alert ${a.wi}] ${a.kind} ${a.launch ?? '-'}: ${a.detail}\n`);
    appendDurably(this.path, JSON.stringify({ ...a, id: alertIdentity(this.source, a), source: this.source }));
  }
}

/**
 * The local copy first, then the ledger. A failed ledger delivery leaves the local copy
 * undelivered (undeliveredAlerts) for the scheduler to carry over; it never throws.
 */
export class DeliveringAlertSink implements AlertSink {
  private readonly local: FileAlertSink;
  private readonly stateDir: string;
  private readonly source: string;
  private ledger: { readonly client: AlertLedger; readonly content: ContentStore } | null;
  /** Alerts raised before a ledger was attached (delivered on attach). */
  private readonly queued: ExecAlert[] = [];
  private readonly inflight = new Set<Promise<void>>();

  constructor(stateDir: string, source: string, ledger: { readonly client: AlertLedger; readonly content: ContentStore } | null = null) {
    this.stateDir = stateDir;
    this.source = source;
    this.local = new FileAlertSink(stateDir, source);
    this.ledger = ledger;
  }

  attach(ledger: { readonly client: AlertLedger; readonly content: ContentStore }): void {
    this.ledger = ledger;
    for (const a of this.queued.splice(0)) this.track(this.deliver(a));
  }

  alert(a: ExecAlert): Promise<void> {
    this.local.alert(a);
    if (this.ledger === null) {
      this.queued.push(a);
      return Promise.resolve();
    }
    return this.track(this.deliver(a));
  }

  private track(p: Promise<void>): Promise<void> {
    this.inflight.add(p);
    void p.finally(() => this.inflight.delete(p));
    return p;
  }

  private async deliver(a: ExecAlert): Promise<void> {
    const l = this.ledger;
    if (l === null) return;
    try {
      const alert = await deliverToLedger(l.client, l.content, this.source, a);
      appendDurably(deliveredPath(this.stateDir), JSON.stringify({ id: alert }));
    } catch (e) {
      process.stderr.write(`[alert] ${a.kind}: not delivered to the ledger (${(e as Error).message}); the local copy is kept\n`);
    }
  }

  /** Waits (bounded) for deliveries in flight. */
  async flush(timeoutMs = 10_000): Promise<void> {
    let t: NodeJS.Timeout | undefined;
    await Promise.race([Promise.allSettled([...this.inflight]), new Promise((r) => (t = setTimeout(r, timeoutMs)))]);
    if (t !== undefined) clearTimeout(t);
  }
}

/** Notes that the ledger has an alert (so undeliveredAlerts no longer lists it). */
export function markAlertDelivered(stateDir: string, source: string, a: Pick<ExecAlert, 'kind' | 'launch' | 'key'>): void {
  appendDurably(deliveredPath(stateDir), JSON.stringify({ id: alertIdentity(source, a) }));
}

export interface StoredAlert extends ExecAlert {
  readonly id: AlertId;
  readonly source: string;
}

function readLines(path: string): unknown[] {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw e;
  }
  const out: unknown[] = [];
  for (const l of text.split('\n')) {
    if (l === '') continue;
    try {
      out.push(JSON.parse(l));
    } catch {
      /* a torn last line */
    }
  }
  return out;
}

export function readAlerts(stateDir: string): StoredAlert[] {
  return readLines(alertsPath(stateDir)) as StoredAlert[];
}

/** Local alerts the ledger has not confirmed (to be carried over by the scheduler). */
export function undeliveredAlerts(stateDir: string): StoredAlert[] {
  const delivered = new Set((readLines(deliveredPath(stateDir)) as { id?: string }[]).map((d) => d.id));
  const seen = new Set<string>();
  return readAlerts(stateDir).filter((a) => {
    if (typeof a.id !== 'string' || delivered.has(a.id) || seen.has(a.id)) return false;
    seen.add(a.id);
    return true;
  });
}

/** Carries undelivered local alerts into the ledger; returns how many were delivered now. */
export async function deliverPendingAlerts(stateDir: string, ledger: AlertLedger, content: ContentStore): Promise<number> {
  let n = 0;
  for (const a of undeliveredAlerts(stateDir)) {
    try {
      await deliverToLedger(ledger, content, a.source, a);
      appendDurably(deliveredPath(stateDir), JSON.stringify({ id: a.id }));
      n++;
    } catch {
      /* still unavailable: next time */
    }
  }
  return n;
}
