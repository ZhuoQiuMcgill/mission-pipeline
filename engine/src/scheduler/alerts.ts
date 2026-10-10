// Exception notices raised by the scheduler and the watchdog (3.9, 3.11, 6.1, 6.3). Each one
// names the PM work instruction (WI, design 3.11) that tells the PM what to do, and its body
// holds the trigger facts, the evidence and the default action already taken (which only ever
// stops the one affected action). A copy goes to the
// control plane first (the PM's background monitor reads it even when the ledger is down),
// then the alert is committed to the ledger. An alert's identity is derived from its
// category and key, so raising the same alert again (after a crash, or a retry after a lost
// response) is the same ledger operation. Alerts that could not be committed are kept and
// committed on the next flush.

import { createHash } from 'node:crypto';
import { canonicalJson } from '../common/hash.ts';
import { id, type AlertId } from '../common/ids.ts';
import type { ContentStore } from '../ledger/content.ts';
import type { ControlPlane } from './controlPlane.ts';
import { isTransient, type SchedulerLedger } from './ledger.ts';

export interface AlertInput {
  /** e.g. 'proof-pending-timeout', 'cleanup-failing', 'budget-block', 'storage-fault'. */
  readonly category: string;
  /** The work instruction (design 3.11), e.g. 'WI-08'; null only where no WI exists yet (a defect, reported). */
  readonly wi: string | null;
  /** What the alert is about, unique per occurrence that deserves its own alert (e.g. a launch id). */
  readonly key: string;
  /** The trigger: what happened and how the program found it. */
  readonly trigger?: string;
  /** The default action the program has already taken. */
  readonly defaultAction?: string;
  /** The facts (evidence). */
  readonly detail: unknown;
}

export function alertIdOf(source: string, category: string, key: string): AlertId {
  const h = createHash('sha256').update(`${source}\0${category}\0${key}`).digest('hex').slice(0, 20);
  const safeCat = category.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 60);
  return id<AlertId>(`${source}.${safeCat}.${h}`);
}

export class Alerts {
  private readonly ledger: SchedulerLedger | null;
  private readonly content: ContentStore | null;
  private readonly cp: ControlPlane;
  readonly source: string;
  private readonly unsent = new Map<string, { alert: AlertId; input: AlertInput }>();
  private readonly now: () => number;

  constructor(opts: { ledger: SchedulerLedger | null; content: ContentStore | null; controlPlane: ControlPlane; source: string; now?: () => number }) {
    this.ledger = opts.ledger;
    this.content = opts.content;
    this.cp = opts.controlPlane;
    this.source = opts.source;
    this.now = opts.now ?? Date.now;
  }

  /** Raise an alert: control-plane copy first, then the ledger (kept for a later flush if that fails). */
  async raise(input: AlertInput): Promise<AlertId> {
    const alert = alertIdOf(this.source, input.category, input.key);
    if (!this.cp.hasAlert(alert)) {
      this.cp.putAlert({
        format: 'mp4.alert-copy.v1',
        alert,
        category: input.category,
        wi: input.wi,
        key: input.key,
        trigger: input.trigger ?? null,
        defaultAction: input.defaultAction ?? null,
        detail: input.detail,
        source: this.source,
        at: this.now(),
        committed: false,
      });
    }
    this.unsent.set(alert, { alert, input });
    await this.commit(alert);
    return alert;
  }

  private async commit(alert: string): Promise<boolean> {
    const u = this.unsent.get(alert);
    if (!u) return true;
    if (this.ledger === null || this.content === null) return false;
    try {
      // The body is deterministic for (category, key, detail): a retry is the same operation.
      const body = this.content.put(
        canonicalJson({
          format: 'mp4.alert.v1',
          source: this.source,
          category: u.input.category,
          wi: u.input.wi,
          key: u.input.key,
          trigger: u.input.trigger ?? null,
          defaultAction: u.input.defaultAction ?? null,
          detail: u.input.detail,
        }),
      );
      await this.ledger.raiseAlert(`alert:${u.alert}`, u.alert, u.input.category, body, u.input.wi);
      this.unsent.delete(alert);
      const copy = this.cp.alerts().find((a) => a.alert === alert);
      if (copy && !copy.committed) this.cp.putAlert({ ...copy, committed: true });
      return true;
    } catch (e) {
      if (isTransient(e) || (e as NodeJS.ErrnoException).code !== undefined) return false;
      // OP_CONFLICT etc.: the same alert id with another body; keep the control-plane copy, drop it here.
      this.unsent.delete(alert);
      return false;
    }
  }

  /** Commit alerts the ledger did not have yet. */
  async flush(): Promise<number> {
    let n = 0;
    for (const a of [...this.unsent.keys()]) if (await this.commit(a)) n++;
    return n;
  }

  get pending(): number {
    return this.unsent.size;
  }
}
