// Rebuild every state table from the log (design 10.1 rule 3; core review r2 F17).
//
// The log (`log`, the revisioned base records and service events) and the
// journal (service events that create no revision) are replayed as one
// sequence: every journal entry right after the log record it followed. Each
// record goes through the same projection the service applied when it committed
// the record (projection.ts), with the record's own commit time, and content it
// refers to is read back (and hash-checked) from the content store.
//
// Two modes:
// - `into`: copy the log and the journal into a fresh database at that path and
//   replay there (the source is read in one read transaction, a consistent
//   snapshot even while the service writes; used to check a live ledger);
// - in place: the ledger's state tables must be empty (for example after they
//   were dropped as damaged); the writer lock is taken for the duration.

import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { dirname, join } from 'node:path';
import type { BaseRecord } from '../common/records.ts';
import { ContentStore } from './content.ts';
import { project, type ProjectionContext } from './projection.ts';
import { STATE_KEYS, STATE_TABLES, Store } from './store.ts';
import { WriterLock } from './writerLock.ts';

export interface RebuildReport {
  readonly records: number;
  readonly journal: number;
}

const PAGE = 5_000;

interface LogRow {
  readonly rev: number;
  readonly kind: string;
  readonly op: string | null;
  readonly record: string;
  readonly committed_at: number;
}

interface JournalRow {
  readonly seq: number;
  readonly after_rev: number;
  readonly kind: string;
  readonly op: string | null;
  readonly record: string;
  readonly committed_at: number;
}

function replay(s: Store, content: ContentStore): RebuildReport {
  const ctx = (rev: number, at: number): ProjectionContext => ({
    rev,
    at,
    blob: (h) => content.get(h).toString('utf8'),
    list: (ref) => content.getList(ref),
  });
  const logPage = s.db.prepare('SELECT rev, kind, op, record, committed_at FROM log WHERE rev > ? ORDER BY rev LIMIT ?');
  const journalPage = s.db.prepare('SELECT seq, after_rev, kind, op, record, committed_at FROM journal WHERE seq > ? ORDER BY seq LIMIT ?');
  let journal: JournalRow[] = [];
  let jAt = 0;
  let jSeq = 0;
  let journalCount = 0;
  let journalDone = false;
  const nextJournal = (): JournalRow | null => {
    if (jAt >= journal.length) {
      if (journalDone) return null;
      journal = journalPage.all(jSeq, PAGE) as unknown as JournalRow[];
      jAt = 0;
      if (journal.length === 0) {
        journalDone = true;
        return null;
      }
    }
    return journal[jAt] ?? null;
  };
  const journalUpTo = (rev: number): void => {
    for (let j = nextJournal(); j !== null && j.after_rev <= rev; j = nextJournal()) {
      project(s, JSON.parse(j.record) as BaseRecord, ctx(j.after_rev, j.committed_at));
      jSeq = j.seq;
      jAt++;
      journalCount++;
    }
  };
  journalUpTo(0);
  let records = 0;
  let after = 0;
  for (;;) {
    const rows = logPage.all(after, PAGE) as unknown as LogRow[];
    if (rows.length === 0) break;
    for (const r of rows) {
      project(s, JSON.parse(r.record) as BaseRecord, ctx(r.rev, r.committed_at));
      records++;
      journalUpTo(r.rev);
      after = r.rev;
    }
  }
  journalUpTo(Number.MAX_SAFE_INTEGER);
  return { records, journal: journalCount };
}

/**
 * Replay the log into empty state tables. With `into`, a fresh database is
 * created there from a copy of the log and the journal; otherwise the state
 * tables of `dbPath` itself must be empty and its writer lock free.
 */
export function rebuildStateFromLog(dbPath: string, contentRoot: string, opts: { into?: string } = {}): RebuildReport {
  const content = new ContentStore(contentRoot);
  if (opts.into !== undefined) {
    if (existsSync(opts.into)) throw new Error(`rebuild target ${opts.into} already exists`);
    const src = new DatabaseSync(dbPath, { readOnly: true, timeout: 2000 });
    const target = new Store(opts.into);
    // One read transaction on the source: the log and the journal come from the
    // same snapshot, whatever the writer commits meanwhile (core review r3 #8).
    src.exec('BEGIN');
    try {
      return target.tx(() => {
        const insLog = target.db.prepare('INSERT INTO log (rev, kind, op, record, committed_at) VALUES (?, ?, ?, ?, ?)');
        const insJournal = target.db.prepare('INSERT INTO journal (seq, after_rev, kind, op, record, committed_at) VALUES (?, ?, ?, ?, ?, ?)');
        const logPage = src.prepare('SELECT rev, kind, op, record, committed_at FROM log WHERE rev > ? ORDER BY rev LIMIT ?');
        for (let after = 0; ; ) {
          const rows = logPage.all(after, PAGE) as unknown as LogRow[];
          if (rows.length === 0) break;
          for (const r of rows) insLog.run(r.rev, r.kind, r.op, r.record, r.committed_at);
          after = rows[rows.length - 1]!.rev;
        }
        const jPage = src.prepare('SELECT seq, after_rev, kind, op, record, committed_at FROM journal WHERE seq > ? ORDER BY seq LIMIT ?');
        for (let after = 0; ; ) {
          const rows = jPage.all(after, PAGE) as unknown as JournalRow[];
          if (rows.length === 0) break;
          for (const r of rows) insJournal.run(r.seq, r.after_rev, r.kind, r.op, r.record, r.committed_at);
          after = rows[rows.length - 1]!.seq;
        }
        return replay(target, content);
      });
    } finally {
      try {
        src.exec('COMMIT');
      } catch {
        /* nothing to end */
      }
      target.close();
      src.close();
    }
  }
  const lock = new WriterLock(join(dirname(dbPath), 'writer.lock'));
  lock.acquire();
  try {
    const store = new Store(dbPath);
    try {
      for (const t of STATE_TABLES) {
        if (store.db.prepare(`SELECT 1 FROM ${t} LIMIT 1`).get()) throw new Error(`state table ${t} is not empty; rebuild replays into empty tables`);
      }
      for (const k of STATE_KEYS) if (store.getState(k) !== null) throw new Error(`service state ${k} is set; rebuild replays into empty state`);
      return store.tx(() => replay(store, content));
    } finally {
      store.close();
    }
  } finally {
    lock.release();
  }
}
