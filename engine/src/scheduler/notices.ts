// Notices and alerts after each publication (design 6.1 "降级告知按失效轮次生成", 3.9).
//
//  - The evaluator runs as the scheduler's child under EvaluatorSupervisor (deadline, heap cap,
//    failure budget, one rebuild, fault state).
//  - After each publication the scheduler expands the committed episode batches into notices
//    (expandNotices: identities make it idempotent, so a crash or a restarted scheduler never
//    duplicates or loses one). Notices are bookkeeping: they never produce new batches.
//  - Every system alert committed to the ledger, by anyone, is copied to the control plane,
//    where the PM's background monitor reads it.

import type { AlertId, ContentHash, Generation, Revision } from '../common/ids.ts';
import { EvaluatorSupervisor, type EvaluatorSupervisorOptions } from '../evaluator/supervisor.ts';
import { expandNotices } from '../evaluator/notices.ts';
import type { ContentStore } from '../ledger/content.ts';
import type { ControlPlane } from './controlPlane.ts';
import type { SchedulerLedger } from './ledger.ts';
import type { LedgerReader } from './reader.ts';

export class NoticePump {
  private readonly reader: LedgerReader;
  private readonly ledger: SchedulerLedger;
  private readonly content: ContentStore;
  private readonly cp: ControlPlane;
  private noticeCursor = 0 as Revision;
  private alertCursor = 0 as Revision;
  noticesCommitted = 0;
  alertsCopied = 0;

  constructor(o: { reader: LedgerReader; ledger: SchedulerLedger; content: ContentStore; cp: ControlPlane }) {
    this.reader = o.reader;
    this.ledger = o.ledger;
    this.content = o.content;
    this.cp = o.cp;
  }

  /** Expand notices committed since the last run and copy new alerts. */
  async run(): Promise<void> {
    const r = await expandNotices(
      {
        readRecordsAfter: (after) => this.reader.readRecordsAfter(after),
        appendRecords: (req) => this.ledger.appendRecords(req.op, req.gen, req.records),
      },
      this.content,
      this.noticeCursor,
    );
    this.noticeCursor = r.cursor;
    this.noticesCommitted += r.committed;
    this.copyAlerts();
  }

  /** Copy every alert record committed since the last copy to the control plane. */
  copyAlerts(): void {
    const recs = this.reader.readRecordsAfter(this.alertCursor);
    for (const c of recs) {
      this.alertCursor = c.revision;
      if (c.record.kind !== 'alert') continue;
      const a = c.record;
      let detail: unknown = null;
      let key = '';
      let source = 'ledger';
      let trigger: unknown = null;
      let defaultAction: string | null = null;
      try {
        const body = JSON.parse(this.content.get(a.body as ContentHash).toString('utf8')) as { key?: string | null; detail?: unknown; source?: string; trigger?: unknown; defaultAction?: string };
        detail = body.detail ?? body;
        key = body.key ?? '';
        source = body.source ?? source;
        trigger = body.trigger ?? null;
        defaultAction = body.defaultAction ?? null;
      } catch {
        detail = { body: a.body };
      }
      const existing = this.cp.alerts().find((x) => x.alert === a.alert);
      if (existing?.committed) continue;
      this.cp.putAlert({
        format: 'mp4.alert-copy.v1',
        alert: a.alert as AlertId,
        category: a.category,
        wi: a.wi ?? null,
        key,
        trigger,
        defaultAction,
        detail,
        source,
        at: existing?.at ?? Date.now(),
        committed: true,
      });
      this.alertsCopied++;
    }
  }
}

/**
 * The evaluator supervisor's failure counter (6.1). The supervisor names each failure (`op`:
 * a retried call after a lost answer does not count twice) and gives its generation (`gen`:
 * a superseded supervisor cannot change the budget, r3 #7); both go to the ledger as they are.
 */
export function evaluatorFailureRecorder(ledger: SchedulerLedger): (req: { readonly op: string; readonly gen: number }) => Promise<number> {
  return (req) => ledger.recordEvaluatorFailure(req.op, req.gen as Generation);
}

export interface EvaluatorRunnerOptions {
  /** The worker's configuration; its generation is the scheduler's own (6.1: same generation, same takeover rules). */
  readonly worker: Omit<EvaluatorSupervisorOptions['worker'], 'gen'>;
  readonly deadlineMs: number;
  readonly heapMb: number;
  /** The measured memory pool (6.1), passed through to the supervisor. */
  readonly memoryMb?: number;
  readonly memoryPool?: 'auto' | 'cgroup' | 'heap-only';
  readonly systemdRunPath?: string;
  readonly retryMs?: { readonly min: number; readonly max: number };
  readonly env?: NodeJS.ProcessEnv;
}

/** The evaluator under its supervisor, wired to the scheduler's ledger client and content store. */
/**
 * Degradations the user accepted at install (9.6, WI-18), from the ledger's install state
 * (`install.state` records, the item being the degradation, e.g. 'resource-limits'): without
 * 'resource-limits' a machine with no working cgroup memory scope leaves the evaluator
 * 'blocked'. None when the ledger cannot answer (the stricter reading).
 */
export async function acceptedDegradations(ledger: SchedulerLedger): Promise<string[]> {
  try {
    return (await ledger.installStates()).filter((s) => s.accepted).map((s) => s.item);
  } catch {
    return [];
  }
}

export function startEvaluator(
  o: EvaluatorRunnerOptions,
  gen: number,
  ledger: SchedulerLedger,
  content: ContentStore,
  onPublished: (revision: number) => void,
  accepted: readonly string[] = [],
): EvaluatorSupervisor {
  const sup = new EvaluatorSupervisor({
    worker: { ...o.worker, gen },
    ledger: {
      recordEvaluatorFailure: evaluatorFailureRecorder(ledger),
      evaluatorHealth: () => ledger.evaluatorHealth(),
      setEvaluatorFault: (reason, req) => ledger.setEvaluatorFault(reason, req?.gen as Generation | undefined),
      // the supervisor is the single source of the WI-11 notice; its WI travels with it
      raiseAlert: (req) => ledger.raiseAlert(req.op, req.alert, req.category, req.body, req.wi ?? null),
      putContent: (text) => content.put(text),
    },
    deadlineMs: o.deadlineMs,
    heapMb: o.heapMb,
    ...(o.memoryMb !== undefined ? { memoryMb: o.memoryMb } : {}),
    ...(o.memoryPool !== undefined ? { memoryPool: o.memoryPool } : {}),
    ...(o.systemdRunPath !== undefined ? { systemdRunPath: o.systemdRunPath } : {}),
    ...(o.retryMs !== undefined ? { retryMs: o.retryMs } : {}),
    acceptedDegradations: accepted,
    ...(o.env !== undefined ? { env: o.env } : {}),
  });
  sup.on('published', (rev: number) => onPublished(rev));
  return sup;
}
