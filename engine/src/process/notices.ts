// Notices to the PM (design 4.1 §6.1, 3.9): no background watcher. `mp pm next` (and `mp read
// status`) shows the notices not acknowledged yet, undelivered first, and marks the ones it showed
// delivered; `mp pm alerts --ack` acknowledges them. A notice is an 'alert' record (the flows', the
// labels', the delivery's; an exception names its WI) or a 'notice' record (an episode of lost
// proof, 6.1), its body a data value.

import { noticeAudience, PM_NOTICE_ACTIONS } from './noticeAudience.ts';
import { sha256 } from '../common/hash.ts';
import { markNotice, noticeDeliveries, type Db, type Memory } from '../memory/index.ts';

export interface PmNotice {
  /** The id `mp pm alerts --ack` takes. */
  readonly audience: 'pm' | 'secretary';
  readonly action: string | null;
  readonly resolution: string | null;
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

/** Pending notices, oldest first, paged independently of acknowledged history. */
export function listNotices(db: Db, data: { text(h: string): string }, o: { readonly limit?: number; readonly includeAcknowledged?: boolean; readonly audience?: 'pm' | 'secretary'; readonly after?: number } = {}): PmNotice[] {
  const pending: PmNotice[] = [];
  let after = o.after ?? 0;
  while (pending.length < (o.limit ?? Number.POSITIVE_INFINITY)) {
    // Filter delivery history before paging. Long ids are normalized in the JS pass below.
    const rows = db.stmt(`SELECT l.rev, l.kind, l.record, l.committed_at FROM log l
      WHERE l.kind IN ('alert', 'notice') AND l.rev > ?
      ${o.includeAcknowledged === true ? '' : `AND NOT EXISTS (SELECT 1 FROM notice_deliveries d WHERE d.state = 'acknowledged' AND d.notice = CASE WHEN l.kind = 'alert' THEN json_extract(l.record, '$.alert') ELSE 'notice:' || json_extract(l.record, '$.notice') END)`}
      ORDER BY l.rev LIMIT 500`).all(after) as Array<{rev: number; kind: 'alert' | 'notice'; record: string; committed_at: number}>;
    if (rows.length === 0) break;
    after = Number(rows.at(-1)!.rev);
    const items = rows.map((r) => {
      const rec = JSON.parse(r.record) as { alert?: string; notice?: string; category?: string; wi?: string; body: string; trigger?: string; defaultAction?: string };
      let body: Record<string, unknown> = {};
      try {
        body = JSON.parse(data.text(rec.body)) as Record<string, unknown>;
      } catch {
        /* the hash stands in */
      }
      const detail = body['detail'] as Record<string, unknown> | undefined;
      if (detail !== undefined && typeof detail['handoff'] === 'string' && detail['decision'] === undefined) {try {detail['decision'] = (JSON.parse(data.text(detail['handoff'])) as {decision?: unknown}).decision;} catch { /* legacy handoff unavailable */ }}
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
    pending.push(...items
      .map((i): PmNotice => ({ ...i, audience: noticeAudience(i.category, i.detail, i.askUser), action: PM_NOTICE_ACTIONS[i.category]?.action ?? (i.askUser ? 'decide the routed question' : null), resolution: PM_NOTICE_ACTIONS[i.category]?.resolution ?? (i.askUser ? 'a PM or user answer is recorded' : null), state: states.get(i.id) ?? 'undelivered' }))
      .filter((i) => (o.includeAcknowledged === true || i.state !== 'acknowledged') && (o.audience === undefined || i.audience === o.audience) && (o.after === undefined || i.revision > o.after)));
  }
  return pending.slice(0, o.limit ?? Number.POSITIVE_INFINITY);
}

/** Mark notices delivered (shown to the PM) or acknowledged (`mp pm alerts --ack`). */
export function markNotices(memory: Memory, ids: readonly string[], state: 'delivered' | 'acknowledged'): number {
  if (ids.length === 0) return 0;
  let changed = 0;
  for (let offset = 0; offset < ids.length; offset += 500) changed += memory.write({}, (tx) => ids.slice(offset, offset + 500).reduce((n, id) => n + (markNotice(tx, {notice: id, state}).changed ? 1 : 0), 0));
  return changed;
}
