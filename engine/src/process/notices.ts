// Notices to the PM (design 4.1 §6.1, 3.9): no background watcher. `mp pm next` (and `mp read
// status`) shows the notices not acknowledged yet, undelivered first, and marks the ones it showed
// delivered; `mp pm alerts --ack` acknowledges them. A notice is an 'alert' record (the flows', the
// labels', the delivery's; an exception names its WI) or a 'notice' record (an episode of lost
// proof, 6.1), its body a data value.

import { sha256 } from '../common/hash.ts';
import { markNotice, noticeDeliveries, type Db, type Memory } from '../memory/index.ts';

export interface PmNotice {
  /** The id `mp pm alerts --ack` takes. */
  readonly id: string;
  readonly kind: 'alert' | 'notice';
  readonly category: string;
  readonly wi: string | null;
  readonly mission: string | null;
  readonly trigger: string;
  readonly defaultAction: string | null;
  readonly askUser: boolean;
  readonly detail: unknown;
  readonly revision: number;
  readonly at: number;
  readonly state: 'undelivered' | 'delivered' | 'acknowledged';
}

const MAX_ID = 200;

function noticeId(kind: 'alert' | 'notice', raw: string): string {
  const id = kind === 'alert' ? raw : `notice:${raw}`;
  return id.length <= MAX_ID && !/[\u0000-\u001f\u007f]/.test(id) ? id : `${kind}:${sha256(raw).slice(0, 40)}`;
}

/** The notices in the log (newest `limit`), oldest first, with their delivery states. */
export function listNotices(db: Db, data: { text(h: string): string }, o: { readonly limit?: number; readonly includeAcknowledged?: boolean } = {}): PmNotice[] {
  const rows = db.stmt("SELECT rev, kind, record, committed_at FROM log WHERE kind IN ('alert', 'notice') ORDER BY rev DESC LIMIT ?").all(o.limit ?? 500) as Array<{ rev: number; kind: 'alert' | 'notice'; record: string; committed_at: number }>;
  const items = rows.reverse().map((r) => {
    const rec = JSON.parse(r.record) as { alert?: string; notice?: string; category?: string; wi?: string; body: string; trigger?: string; defaultAction?: string };
    let body: Record<string, unknown> = {};
    try {
      body = JSON.parse(data.text(rec.body)) as Record<string, unknown>;
    } catch {
      /* the hash stands in */
    }
    const raw = r.kind === 'alert' ? String(rec.alert) : String(rec.notice);
    return {
      id: noticeId(r.kind, raw),
      kind: r.kind,
      category: r.kind === 'alert' ? String(rec.category ?? '') : 'episode',
      wi: rec.wi ?? (typeof body['wi'] === 'string' ? (body['wi'] as string) : null),
      mission: typeof body['mission'] === 'string' ? (body['mission'] as string) : null,
      trigger: String(rec.trigger ?? body['trigger'] ?? body['category'] ?? ''),
      defaultAction: (rec.defaultAction ?? (typeof body['defaultAction'] === 'string' ? body['defaultAction'] : null)) as string | null,
      askUser: body['askUser'] === true,
      detail: body['detail'] ?? body,
      revision: Number(r.rev),
      at: Number(r.committed_at),
    };
  });
  const states = new Map(noticeDeliveries(db, items.map((i) => i.id)).map((d) => [d.notice, d.state]));
  return items
    .map((i): PmNotice => ({ ...i, state: states.get(i.id) ?? 'undelivered' }))
    .filter((i) => o.includeAcknowledged === true || i.state !== 'acknowledged');
}

/** Mark notices delivered (shown to the PM) or acknowledged (`mp pm alerts --ack`). */
export function markNotices(memory: Memory, ids: readonly string[], state: 'delivered' | 'acknowledged'): number {
  if (ids.length === 0) return 0;
  return memory.write({}, (tx) => ids.reduce((n, id) => n + (markNotice(tx, { notice: id, state }).changed ? 1 : 0), 0));
}
