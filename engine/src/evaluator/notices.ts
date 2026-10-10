// Expanding committed episode batches into notices (design 6.1 "降级告知按失效轮次生成").
//
// The evaluator commits one episode batch per update with a non-empty change
// list, before it publishes. The scheduler expands batches into individual
// notices asynchronously after publication. A notice's identity is
// "batch + operation"; its ledger operation id is derived from that identity,
// so expanding the same batch twice (after any crash, or by a restarted
// scheduler) returns the original commit instead of a second notice.
// Notices are bookkeeping: the evaluator ignores them, so expansion never
// produces new batches, and the system goes quiet once the queue is empty.

import type { Revision } from '../common/ids.ts';
import type { BaseRecord, Committed, EpisodeChange } from '../common/records.ts';
import type { ContentStore } from '../ledger/content.ts';

export interface NoticeLedgerPort {
  readRecordsAfter(after: Revision): Committed[];
  appendRecords(req: { op: string; gen: null; records: readonly BaseRecord[] }): Promise<{ revisions: Revision[] }>;
}

export interface NoticeBody {
  readonly batch: string;
  readonly op: string;
  readonly change: EpisodeChange['change'];
  /** The revision the batch was committed before (the derived state that changed). */
  readonly publishes: number;
}

/**
 * A notice's identity: the pair (batch, operation) as a JSON array, so no id
 * containing the separator can make two pairs collide (core review r3 F15:
 * "A:B"+"C" and "A"+"B:C" were both "A:B:C"), as with reviewPosition and fixKey.
 */
export function noticeIdentity(batch: string, op: string): string {
  return JSON.stringify([batch, op]);
}

/**
 * The notice's trigger facts and default handling (3.9, 3.11 principle 3). An
 * episode change is normal flow, not an exception: the text says what changed
 * and what the program does by default, with no WI.
 */
export function noticeText(change: EpisodeChange, batch: string, publishes: number): { trigger: string; defaultAction: string } {
  if (change.change === 'start') {
    return {
      trigger: `executed operation ${change.op} is no longer all proven as of revision ${publishes}: an object or proof unit it lists lost its proof (6.1; episode batch ${batch})`,
      defaultAction:
        'nothing is undone: the operation stays executed, its objects show their current labels, and it counts as proof debt on layer 0 (and in a closing risk list) until they are proven again',
    };
  }
  return {
    trigger: `executed operation ${change.op} is all proven again as of revision ${publishes} (6.1; episode batch ${batch} ends its episode)`,
    defaultAction: 'none needed: the operation leaves the proof debt',
  };
}

/**
 * Expand every episode change committed after `after` that has no notice yet.
 * Returns the last revision examined (the caller's next cursor) and how many
 * notices this call committed. Safe to run concurrently with itself and after
 * crashes: identities make commits idempotent.
 */
export async function expandNotices(
  port: NoticeLedgerPort,
  content: ContentStore,
  after: Revision,
): Promise<{ cursor: Revision; committed: number }> {
  const records = port.readRecordsAfter(after);
  const noticed = new Set<string>();
  for (const c of records) if (c.record.kind === 'notice') noticed.add(c.record.notice);
  let cursor = after;
  let committed = 0;
  for (const c of records) {
    cursor = c.revision;
    if (c.record.kind !== 'episode.batch') continue;
    const batch = c.record;
    for (const raw of content.getList(batch.changes)) {
      const change = JSON.parse(raw) as EpisodeChange;
      const identity = noticeIdentity(batch.batch, change.op);
      if (noticed.has(identity)) continue;
      const body: NoticeBody = { batch: batch.batch, op: change.op, change: change.change, publishes: batch.publishes };
      const hash = content.put(JSON.stringify(body));
      const text = noticeText(change, batch.batch, batch.publishes);
      await port.appendRecords({
        op: `notice:${identity}`,
        gen: null,
        records: [{ kind: 'notice', notice: identity, audience: 'pm', body: hash, trigger: text.trigger, defaultAction: text.defaultAction }],
      });
      noticed.add(identity);
      committed++;
    }
  }
  return { cursor, committed };
}
