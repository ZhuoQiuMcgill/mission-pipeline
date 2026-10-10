// Notices for the PM (design 3.9, delivery to the PM): system alerts and exception notices
// (each with its WI number and trigger facts, 3.11), and episode notices. They are
// read from the control plane (alert copies: the PM's monitor reads them even when
// the ledger is down) and, read-only, from the ledger's log (episode notices).
//
// Each notice has a delivery state: undelivered, delivered, acknowledged. The ledger records
// them (markNotice, noticeDeliveries); the CLI also keeps them in its state directory so the
// hooks work while the ledger is down, and syncs both ways (syncNotices). A notice whose mark
// is lost is delivered again (a duplicate, never a loss).

import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { writeFileAtomic } from '../common/fsx.ts';
import type { ContentHash } from '../common/ids.ts';
import type { ContentStore } from '../ledger/content.ts';
import type { LedgerClient } from '../ledger/ipc.ts';
import { ControlPlane, type AlertCopy } from '../scheduler/controlPlane.ts';
import { wiRef } from './wi.ts';

export type NoticeState = 'undelivered' | 'delivered' | 'acknowledged';

export interface PmNotice {
  readonly id: string;
  readonly kind: 'alert' | 'notice';
  readonly wi: string | null;
  readonly category: string;
  readonly trigger: string;
  readonly defaultAction: string | null;
  readonly detail: unknown;
  readonly source: string;
  readonly at: number;
  /** Whether the ledger has it (an alert copy written while the ledger was down is not committed yet). */
  readonly committed: boolean;
  readonly state: NoticeState;
}

interface Marks {
  delivered: Record<string, number>;
  confirmed: Record<string, number>;
  /** What the ledger already has (markNotice), so a mark is sent once. */
  pushed: Record<string, 'delivered' | 'acknowledged'>;
}

function marksPath(stateDir: string): string {
  return join(stateDir, 'cli', 'notices.json');
}

function readMarks(stateDir: string): Marks {
  try {
    const m = JSON.parse(readFileSync(marksPath(stateDir), 'utf8')) as Partial<Marks>;
    return { delivered: m.delivered ?? {}, confirmed: m.confirmed ?? {}, pushed: m.pushed ?? {} };
  } catch {
    return { delivered: {}, confirmed: {}, pushed: {} };
  }
}

function writeMarks(stateDir: string, m: Marks): void {
  mkdirSync(join(stateDir, 'cli'), { recursive: true });
  writeFileAtomic(marksPath(stateDir), JSON.stringify(m));
}

function stateOf(m: Marks, id: string): NoticeState {
  return m.confirmed[id] !== undefined ? 'acknowledged' : m.delivered[id] !== undefined ? 'delivered' : 'undelivered';
}

function textOf(x: unknown): string {
  if (typeof x === 'string') return x;
  if (x === null || x === undefined) return '';
  try {
    return JSON.stringify(x);
  } catch {
    return String(x);
  }
}

/** Episode notices (kind 'notice') from the ledger's log, read-only; [] when the database cannot be read. */
function episodeNotices(dbPath: string, content: ContentStore | null, limit: number): Array<Omit<PmNotice, 'state'>> {
  if (!existsSync(dbPath)) return [];
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true, timeout: 1000 });
    const rows = db.prepare("SELECT rev, record, committed_at FROM log WHERE kind = 'notice' ORDER BY rev DESC LIMIT ?").all(limit) as Array<{ rev: number; record: string; committed_at: number }>;
    return rows.map((r) => {
      const rec = JSON.parse(r.record) as { notice: string; body: ContentHash; trigger?: string };
      let detail: unknown = { body: rec.body };
      if (content !== null) {
        try {
          detail = JSON.parse(content.get(rec.body).toString('utf8'));
        } catch {
          /* the body is not readable: its hash is shown */
        }
      }
      return { id: `notice:${rec.notice}`, kind: 'notice' as const, wi: null, category: 'episode', trigger: rec.trigger ?? 'derived state changed (an episode of lost proof)', defaultAction: null, detail, source: 'evaluator', at: Number(r.committed_at), committed: true };
    });
  } catch {
    return [];
  } finally {
    db?.close();
  }
}

export interface NoticeSources {
  readonly controlPlane: string;
  readonly stateDir: string;
  readonly dbPath: string | null;
  readonly content: ContentStore | null;
}

/** Every notice known now, oldest first, with its delivery state. */
export function listNotices(s: NoticeSources, o: { readonly episodeLimit?: number } = {}): PmNotice[] {
  const marks = readMarks(s.stateDir);
  const alerts = new ControlPlane(s.controlPlane).alerts().map(
    (a: AlertCopy): Omit<PmNotice, 'state'> => ({
      id: a.alert,
      kind: 'alert',
      wi: a.wi,
      category: a.category,
      trigger: textOf(a.trigger),
      defaultAction: a.defaultAction,
      detail: a.detail,
      source: a.source,
      at: a.at,
      committed: a.committed,
    }),
  );
  const episodes = s.dbPath === null ? [] : episodeNotices(s.dbPath, s.content, o.episodeLimit ?? 200);
  return [...alerts, ...episodes].sort((a, b) => a.at - b.at).map((n) => ({ ...n, state: stateOf(marks, n.id) }));
}

export function undeliveredNotices(s: NoticeSources): PmNotice[] {
  return listNotices(s).filter((n) => n.state === 'undelivered');
}

/** Mark notices delivered (shown in the PM session); syncNotices sends the marks to the ledger. */
export function markDelivered(stateDir: string, ids: readonly string[], now: number = Date.now()): void {
  if (ids.length === 0) return;
  const m = readMarks(stateDir);
  for (const id of ids) m.delivered[id] ??= now;
  writeMarks(stateDir, m);
}

/** Mark notices acknowledged (the PM has acted on them or told the user). */
export function markAcknowledged(stateDir: string, ids: readonly string[], now: number = Date.now()): void {
  if (ids.length === 0) return;
  const m = readMarks(stateDir);
  for (const id of ids) {
    m.delivered[id] ??= now;
    m.confirmed[id] ??= now;
  }
  writeMarks(stateDir, m);
}

/**
 * The ledger is the record of delivery states (markNotice, noticeDeliveries; 3.9): send it the
 * marks it does not have yet, and take in the states it has (another session, a lost state
 * file). The local marks keep the hooks working while the ledger is down. False: the ledger
 * did not answer (the local marks stand; they are sent next time).
 */
export async function syncNotices(client: LedgerClient, stateDir: string, ids: readonly string[] = []): Promise<boolean> {
  const m = readMarks(stateDir);
  let changed = false;
  try {
    for (const id of Object.keys(m.delivered)) {
      if (id.startsWith('once:')) continue;
      const want: 'delivered' | 'acknowledged' = m.confirmed[id] !== undefined ? 'acknowledged' : 'delivered';
      if (m.pushed[id] === want || m.pushed[id] === 'acknowledged') continue;
      if (want === 'acknowledged' && m.pushed[id] === undefined) await client.call('markNotice', { notice: id, state: 'delivered' });
      await client.call('markNotice', { notice: id, state: want });
      m.pushed[id] = want;
      changed = true;
    }
    const ask = ids.filter((i) => m.pushed[i] !== 'acknowledged');
    for (let i = 0; i < ask.length; i += 1000) {
      const rows = (await client.call('noticeDeliveries', { notices: ask.slice(i, i + 1000) })) as Array<{ notice: string; state: 'delivered' | 'acknowledged'; deliveredAt: number; acknowledgedAt: number | null }>;
      for (const r of rows) {
        m.delivered[r.notice] ??= r.deliveredAt;
        if (r.state === 'acknowledged') m.confirmed[r.notice] ??= r.acknowledgedAt ?? r.deliveredAt;
        m.pushed[r.notice] = r.state;
        changed = true;
      }
    }
    return true;
  } catch {
    return false;
  } finally {
    if (changed) {
      try {
        writeMarks(stateDir, m);
      } catch {
        /* sent again next time */
      }
    }
  }
}

/** A one-time mark for something that is not a notice id (e.g. a startup decision's reminder). */
export function onceMark(stateDir: string, key: string, now: number = Date.now()): boolean {
  const m = readMarks(stateDir);
  if (m.delivered[`once:${key}`] !== undefined) return false;
  m.delivered[`once:${key}`] = now;
  writeMarks(stateDir, m);
  return true;
}

/** Notices as the PM sees them in its context (hooks, the background watcher): the WI number, its title and its page. */
export function noticeLines(ns: readonly PmNotice[], max: number, env: NodeJS.ProcessEnv = process.env): string[] {
  const out: string[] = [];
  for (const n of ns.slice(-max)) {
    const ref = wiRef(n.wi, env);
    out.push(`- ${n.id}${ref !== null ? ` ${ref}` : ''}: ${n.trigger.slice(0, 200)}${n.defaultAction ? `; done: ${n.defaultAction.slice(0, 160)}` : ''}`);
  }
  if (ns.length > max) out.push(`- ${ns.length - max} more: mp alerts`);
  return out;
}
