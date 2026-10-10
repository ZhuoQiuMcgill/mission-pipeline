// Layer 2 reads (design 10.2, 6.1: layer 2 is mostly the base records themselves, read straight from the main ledger):
// base records read straight from the main ledger over a read-only connection,
// by identity (the facts table) or by kind (the log's kind index), newest first and
// bounded. Nothing here writes; nothing here computes derived state.

import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import type { BaseRecord } from '../common/records.ts';

export interface LoggedRecord<R = BaseRecord> {
  readonly revision: number;
  readonly committedAt: number;
  readonly op: string | null;
  readonly record: R;
}

/** At most this many records are scanned by one kind query. */
export const SCAN_LIMIT = 20_000;

export class Layer2Reader {
  private readonly db: DatabaseSync;

  private constructor(db: DatabaseSync) {
    this.db = db;
  }

  /** Null when the database does not exist or cannot be opened. */
  static open(dbPath: string): Layer2Reader | null {
    if (!existsSync(dbPath)) return null;
    try {
      return new Layer2Reader(new DatabaseSync(dbPath, { readOnly: true, timeout: 2000 }));
    } catch {
      return null;
    }
  }

  close(): void {
    try {
      this.db.close();
    } catch {
      /* closed */
    }
  }

  private row(rev: number): LoggedRecord | null {
    const r = this.db.prepare('SELECT rev, op, record, committed_at FROM log WHERE rev = ?').get(rev) as { rev: number; op: string | null; record: string; committed_at: number } | undefined;
    return r ? { revision: Number(r.rev), committedAt: Number(r.committed_at), op: r.op, record: JSON.parse(r.record) as BaseRecord } : null;
  }

  /** The record of one fact identity (basis.version, object.version, judgment, evidence, notice...). */
  fact(kind: string, id: string): LoggedRecord | null {
    const f = this.db.prepare('SELECT rev FROM facts WHERE kind = ? AND id = ?').get(kind, id) as { rev: number } | undefined;
    return f ? this.row(Number(f.rev)) : null;
  }

  /** Records of one kind matching `pred`, newest first, at most `limit` matches, scanning at most SCAN_LIMIT. */
  byKind<R = BaseRecord>(kind: string, pred: (r: R) => boolean, limit = 20): LoggedRecord<R>[] {
    const out: LoggedRecord<R>[] = [];
    let before = Number.MAX_SAFE_INTEGER;
    let scanned = 0;
    while (out.length < limit && scanned < SCAN_LIMIT) {
      const rows = this.db.prepare('SELECT rev, op, record, committed_at FROM log WHERE kind = ? AND rev < ? ORDER BY rev DESC LIMIT 500').all(kind, before) as Array<{ rev: number; op: string | null; record: string; committed_at: number }>;
      if (rows.length === 0) break;
      for (const r of rows) {
        scanned++;
        const rec = JSON.parse(r.record) as R;
        if (pred(rec)) out.push({ revision: Number(r.rev), committedAt: Number(r.committed_at), op: r.op, record: rec });
        if (out.length >= limit) break;
      }
      before = Number(rows[rows.length - 1]!.rev);
    }
    return out;
  }
}

export interface DeliveryRecorded {
  readonly kind: 'delivery.recorded';
  readonly mission: string;
  readonly delivery: string;
  readonly commit: string;
  readonly base: string;
  readonly ref: string;
  readonly manifest: string;
}

export function findDelivery(r: Layer2Reader, delivery: string): LoggedRecord<DeliveryRecorded> | null {
  return r.byKind<DeliveryRecorded>('delivery.recorded', (x) => x.delivery === delivery || x.ref.endsWith(`/${delivery}`), 1)[0] ?? null;
}

export function deliveriesOf(r: Layer2Reader, mission: string, limit = 20): LoggedRecord<DeliveryRecorded>[] {
  return r.byKind<DeliveryRecorded>('delivery.recorded', (x) => x.mission === mission, limit);
}
