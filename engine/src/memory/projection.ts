// State tables as a projection of the log (design 4.1 §3.2, §3.3 step 4; 4.0
// 10.1 rule 3, core review r2 F17).
//
// Every change a write makes to a state table is the effect of one event it
// appends in the same transaction: the write appends the event, then applies
// `project` to it. A rebuild replays the log through the same function, so the
// rebuilt tables equal the live ones by construction. Checks (stops, conflicts,
// claims...) happen in the domain functions before the event is appended;
// `project` only applies effects. The projection reads nothing but the event
// and the state tables (no data values), so a rebuild never depends on them.

import { canonicalJson, hashJson } from '../common/hash.ts';
import { NO_PROGRESS_EXEMPT, type BaseRecord } from '../common/records.ts';
import type { Db } from './db.ts';
import { setKey } from './db.ts';
import type { LogRecord } from './events.ts';

export interface ProjectionContext {
  /** The event's revision. */
  readonly rev: number;
  /** Its commit time: every timestamp column takes this value. */
  readonly at: number;
}

/** The identity of a fact, written at most once with one payload (moved from ledger/projection.ts). */
export function identityOf(r: BaseRecord): string | null {
  switch (r.kind) {
    case 'basis.version':
      return r.version;
    case 'object.version':
      return r.object;
    case 'proof.unit':
      return r.unit;
    case 'judgment':
      return r.judgment;
    case 'evidence':
      return r.evidence;
    case 'issue':
      return r.issue;
    case 'op.pending':
    case 'op.executed':
      return r.op;
    case 'episode.batch':
      return r.batch;
    case 'notice':
      return r.notice;
    case 'seat.result':
      return r.launch;
    case 'user.words':
      return r.message;
    case 'flow.event':
      // A JSON tuple: no separator can make two identities meet.
      return JSON.stringify([r.mission, r.line, r.event, r.key]);
    default:
      return null;
  }
}

/** The mission a record belongs to, when it names one (a top-level `mission`, or an operation's scope). */
export function missionOf(rec: { readonly kind: string }): string | null {
  const m = (rec as { mission?: unknown }).mission;
  if (typeof m === 'string') return m;
  if (rec.kind === 'op.pending') return (rec as Extract<BaseRecord, { kind: 'op.pending' }>).scope.mission;
  return null;
}

/**
 * Loop counters per (lineage, loop), maintained with the records (6.5).
 * `no_progress_at`: the attempt count at which the same failure signature came
 * twice in a row (not for exempt loops). It stays until a grant, whatever
 * attempts follow: exhaustion is persistent (6.5 "耗尽之后"). A grant records
 * the attempt count it was made at (`attempts_at_grant`). The checks (one
 * Secretary grant per lineage, no attempt on an exhausted loop) are made
 * before the record is appended (domain/facts.ts).
 */
export function countLoop(s: Db, r: Extract<BaseRecord, { kind: 'loop.attempt' } | { kind: 'loop.grant' }>): void {
  const row = s.stmt('SELECT attempts, by_class, last_signature, repeats, secretary_grants, extra, attempts_at_grant, no_progress_at FROM loops WHERE lineage = ? AND loop = ?').get(r.lineage, r.loop) as
    | { attempts: number; by_class: string; last_signature: string | null; repeats: number; secretary_grants: number; extra: number; attempts_at_grant: number | null; no_progress_at: number | null }
    | undefined;
  const cur = row ?? { attempts: 0, by_class: '{}', last_signature: null, repeats: 0, secretary_grants: 0, extra: 0, attempts_at_grant: null, no_progress_at: null };
  const upsert = s.stmt(
    'INSERT INTO loops (lineage, loop, attempts, by_class, last_signature, repeats, secretary_grants, extra, attempts_at_grant, no_progress_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(lineage, loop) DO UPDATE SET attempts = excluded.attempts, by_class = excluded.by_class, last_signature = excluded.last_signature, repeats = excluded.repeats, secretary_grants = excluded.secretary_grants, extra = excluded.extra, attempts_at_grant = excluded.attempts_at_grant, no_progress_at = excluded.no_progress_at',
  );
  if (r.kind === 'loop.attempt') {
    // A prototype-less map: a class named "constructor" or "__proto__" is an ordinary key.
    const byClass = Object.assign(Object.create(null) as Record<string, number>, JSON.parse(cur.by_class) as Record<string, number>);
    if (r.failureClass !== null) byClass[r.failureClass] = (Object.hasOwn(byClass, r.failureClass) ? byClass[r.failureClass]! : 0) + 1;
    const attempts = cur.attempts + 1;
    const repeats = cur.last_signature === r.signature ? cur.repeats + 1 : 0;
    const noProgress = cur.no_progress_at ?? (repeats >= 1 && !NO_PROGRESS_EXEMPT.has(r.loop) ? attempts : null);
    upsert.run(r.lineage, r.loop, attempts, JSON.stringify(byClass), r.signature, repeats, cur.secretary_grants, cur.extra, cur.attempts_at_grant, noProgress);
  } else {
    upsert.run(r.lineage, r.loop, cur.attempts, cur.by_class, cur.last_signature, cur.repeats, cur.secretary_grants + (r.by === 'secretary' ? 1 : 0), cur.extra + r.extra, cur.attempts, null);
  }
}

function fillerCols(f: { harness: string; model: string | null } | null | undefined): [string | null, string | null] {
  return f ? [f.harness, f.model] : [null, null];
}

/** Apply the effects of one committed event to the state tables. */
export function project(s: Db, rec: LogRecord, ctx: ProjectionContext): void {
  // Reads by kind and mission (recordsByKind) use this index instead of scanning the log.
  const mission = missionOf(rec);
  if (mission !== null) s.stmt('INSERT INTO record_missions (rev, kind, mission) VALUES (?, ?, ?)').run(ctx.rev, rec.kind, mission);
  if (rec.kind !== 'op.receipt' && !rec.kind.startsWith('memory.')) {
    const base = rec as BaseRecord;
    const ident = identityOf(base);
    if (ident !== null) {
      s.stmt('INSERT INTO facts (kind, id, payload_hash, rev) VALUES (?, ?, ?, ?)').run(base.kind, ident, hashJson(base), ctx.rev);
      if (base.kind === 'op.pending') s.stmt('INSERT INTO op_scopes (op, mission, capabilities) VALUES (?, ?, ?)').run(base.op, base.scope.mission, canonicalJson(base.scope.capabilities));
    }
  }
  switch (rec.kind) {
    // ---- the memory's own events
    case 'op.receipt':
      s.stmt('INSERT INTO ops (op, payload_hash, response, rev) VALUES (?, ?, ?, ?)').run(rec.op, rec.payloadHash, rec.response, ctx.rev);
      if (rec.command !== undefined) {
        const [harness, model] = fillerCols(rec.filler);
        s.stmt('INSERT INTO pm_commands (op, command, harness, model, at, rev) VALUES (?, ?, ?, ?, ?, ?)').run(rec.op, rec.command, harness, model, ctx.at, ctx.rev);
      }
      return;
    case 'dispatch.claimed': {
      const [harness, model] = fillerCols(rec.filler);
      s.stmt(
        `INSERT INTO dispatches (dispatch, task, seat, mission, lineage, capabilities, state, released, handback, handback_hash, result, filler_harness, filler_model,
           handback_harness, handback_model, worktree, card_leaf, report_leaf, claimed_rev, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'in-flight', NULL, NULL, NULL, NULL, ?, ?, NULL, NULL, ?, ?, NULL, ?, ?, ?)`,
      ).run(rec.dispatch, rec.task, rec.seat, rec.mission, rec.lineage, canonicalJson(rec.capabilities), harness, model, rec.worktree, rec.card, ctx.rev, ctx.at, ctx.at);
      s.stmt("UPDATE tasks SET state = 'dispatched', dispatch = ?, by_task = NULL, updated_at = ? WHERE task = ?").run(rec.dispatch, ctx.at, rec.task);
      return;
    }
    case 'dispatch.handback': {
      const [harness, model] = fillerCols(rec.filler);
      // A late hand-back (after a release) leaves the released state as it is; the others end the dispatch.
      s.stmt(
        "UPDATE dispatches SET state = CASE WHEN state = 'released' THEN 'released' ELSE 'handed-back' END, handback = ?, handback_hash = ?, result = ?, handback_harness = ?, handback_model = ?, report_leaf = ?, updated_at = ? WHERE dispatch = ?",
      ).run(rec.outcome, rec.payloadHash, rec.result, harness, model, rec.report, ctx.at, rec.dispatch);
      // The seat is done: its leases are free, unless the dispatch was abandoned (held until the PM releases it as ended, §5.4).
      if (rec.outcome !== 'after-release') s.stmt('DELETE FROM leases WHERE dispatch = ?').run(rec.dispatch);
      return;
    }
    case 'dispatch.released':
      s.stmt("UPDATE dispatches SET state = 'released', released = ?, updated_at = ? WHERE dispatch = ?").run(rec.how, ctx.at, rec.dispatch);
      if (rec.how === 'ended') s.stmt('DELETE FROM leases WHERE dispatch = ?').run(rec.dispatch);
      return;
    case 'lease.acquired':
      s.stmt('INSERT INTO leases (resource, dispatch, acquired_at, rev) VALUES (?, ?, ?, ?) ON CONFLICT(resource) DO UPDATE SET dispatch = excluded.dispatch, acquired_at = excluded.acquired_at, rev = excluded.rev').run(
        rec.resource,
        rec.dispatch,
        ctx.at,
        ctx.rev,
      );
      return;
    case 'leaf.recorded':
      s.stmt('INSERT INTO leaves (leaf, kind, file, anchor, sha256, op, rev) VALUES (?, ?, ?, ?, ?, (SELECT op FROM log WHERE rev = ?), ?)').run(rec.leaf, rec.leafKind, rec.file, rec.anchor, rec.sha256, ctx.rev, ctx.rev);
      return;
    case 'cursor.set':
      s.stmt('INSERT INTO cursors (cursor, rev, at, set_rev) VALUES (?, ?, ?, ?) ON CONFLICT(cursor) DO UPDATE SET rev = excluded.rev, at = excluded.at, set_rev = excluded.set_rev').run(rec.cursor, rec.rev, ctx.at, ctx.rev);
      return;
    case 'memory.init':
    case 'memory.moved':
    case 'memory.git-confirmed':
    case 'memory.truncated':
      return;
    // ---- base records and the 4.0 service events 4.1 keeps
    case 'user.words': {
      const w = rec as typeof rec & { words?: string; leaf?: string };
      const words = w.words ?? `W-${Number((s.stmt('SELECT COUNT(*) AS n FROM words').get() as { n: number }).n) + 1}`;
      s.stmt('INSERT INTO words (words, message, session, at, text, leaf, rev) VALUES (?, ?, ?, ?, ?, ?, ?)').run(words, rec.message, rec.session, rec.at, rec.text, w.leaf ?? null, ctx.rev);
      return;
    }
    case 'stop.committed':
      s.stmt("INSERT INTO stops (stop, scope, words, words_entry, state, requested_at, committed_at, narrows) VALUES (?, ?, ?, ?, 'active', ?, ?, ?)").run(
        rec.stop,
        canonicalJson(rec.scope),
        rec.words,
        (rec as { wordsEntry?: string }).wordsEntry ?? null,
        rec.at,
        ctx.at,
        rec.narrows ?? null,
      );
      return;
    case 'stop.released':
      s.stmt("UPDATE stops SET state = 'released', released_at = ?, narrowed_to = ? WHERE stop = ?").run(ctx.at, rec.narrowedTo ?? null, rec.stop);
      return;
    case 'notice.delivery':
      if (rec.state === 'delivered') {
        s.stmt("INSERT INTO notice_deliveries (notice, state, delivered_at, acknowledged_at, rev) VALUES (?, 'delivered', ?, NULL, ?) ON CONFLICT(notice) DO NOTHING").run(rec.notice, ctx.at, ctx.rev);
      } else {
        s.stmt(
          "INSERT INTO notice_deliveries (notice, state, delivered_at, acknowledged_at, rev) VALUES (?, 'acknowledged', ?, ?, ?) ON CONFLICT(notice) DO UPDATE SET state = 'acknowledged', acknowledged_at = excluded.acknowledged_at, rev = excluded.rev",
        ).run(rec.notice, ctx.at, ctx.at, ctx.rev);
      }
      return;
    case 'pm.action':
      s.stmt(
        `INSERT INTO pm_actions (action, command, args_hash, args, wi, state, started_at, ended_at, result, rev) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(action) DO UPDATE SET state = excluded.state, ended_at = excluded.ended_at, result = excluded.result, rev = excluded.rev`,
      ).run(rec.action, rec.command, rec.argsHash, rec.args, rec.wi, rec.state, ctx.at, rec.state === 'started' ? null : ctx.at, rec.result, ctx.rev);
      return;
    case 'mission.close':
      s.stmt('INSERT INTO mission_closes (mission, version, mode, wait_running, as_of, unfinished, snapshot, rev, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
        rec.mission,
        rec.version,
        rec.mode,
        rec.waitRunning ? 1 : 0,
        rec.asOf,
        rec.unfinished,
        rec.snapshot,
        ctx.rev,
        ctx.at,
      );
      return;
    case 'mission.state':
      s.stmt('INSERT INTO missions (mission, state) VALUES (?, ?) ON CONFLICT(mission) DO UPDATE SET state = excluded.state').run(rec.mission, rec.state);
      return;
    case 'intent.authorized': {
      const d = rec.delivery ?? null;
      s.stmt("INSERT INTO intents (intent, op, kind, domain, mission, capabilities, state, details, updated_at, delivery) VALUES (?, ?, ?, ?, ?, ?, 'authorized', ?, ?, ?)").run(
        rec.intent,
        rec.op,
        rec.intentKind,
        rec.domain,
        rec.mission,
        canonicalJson(rec.capabilities),
        rec.details,
        ctx.at,
        d === null ? null : canonicalJson(d),
      );
      if (d !== null && rec.intentKind === 'delivery-ref') {
        // The delivery's first ref authorization fixes its place in the mission's order (seq); a recorded or
        // withdrawn delivery keeps what it has.
        s.stmt(
          `INSERT INTO deliveries (mission, delivery, state, commit_id, base, ref, target, manifest, seq, recorded_rev, withdrawn_reason, updated_at, description)
           VALUES (?, ?, 'creating', ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)
           ON CONFLICT(mission, delivery) DO UPDATE SET commit_id = excluded.commit_id, base = excluded.base, ref = excluded.ref,
             target = COALESCE(excluded.target, deliveries.target), manifest = COALESCE(excluded.manifest, deliveries.manifest), updated_at = excluded.updated_at,
             description = COALESCE(excluded.description, deliveries.description)
           WHERE deliveries.state = 'creating'`,
        ).run(d.mission, d.op, d.commit, d.base, d.ref, d.targetBranch, d.manifest, ctx.rev, ctx.at, d.description ?? null);
      }
      return;
    }
    case 'intent.state':
      s.stmt('UPDATE intents SET state = ?, updated_at = ? WHERE intent = ?').run(rec.state, ctx.at, rec.intent);
      return;
    case 'delivery.recorded':
      s.stmt(
        `INSERT INTO deliveries (mission, delivery, state, commit_id, base, ref, target, manifest, seq, recorded_rev, withdrawn_reason, updated_at, description)
         VALUES (?, ?, 'recorded', ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)
         ON CONFLICT(mission, delivery) DO UPDATE SET state = CASE WHEN deliveries.state = 'withdrawn' THEN 'withdrawn' ELSE 'recorded' END,
           commit_id = excluded.commit_id, base = excluded.base, ref = excluded.ref, target = COALESCE(excluded.target, deliveries.target),
           manifest = excluded.manifest, recorded_rev = excluded.recorded_rev, updated_at = excluded.updated_at,
           description = COALESCE(excluded.description, deliveries.description)`,
      ).run(rec.mission, rec.delivery, rec.commit, rec.base, rec.ref, rec.target ?? null, rec.manifest, ctx.rev, ctx.rev, ctx.at, rec.description ?? null);
      return;
    case 'delivery.withdrawn':
      s.stmt("UPDATE deliveries SET state = 'withdrawn', withdrawn_reason = ?, updated_at = ? WHERE mission = ? AND delivery = ?").run(rec.reason, ctx.at, rec.mission, rec.delivery);
      return;
    case 'flow.event':
      s.stmt('INSERT INTO flow_events (mission, line, event, key, body, revision) VALUES (?, ?, ?, ?, ?, ?)').run(rec.mission, rec.line, rec.event, rec.key, rec.body, ctx.rev);
      return;
    case 'landing.phase':
      s.stmt(
        'INSERT INTO landings (landing, intent, phase, data, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(landing) DO UPDATE SET phase = excluded.phase, data = excluded.data, intent = COALESCE(excluded.intent, landings.intent), updated_at = excluded.updated_at',
      ).run(rec.landing, rec.intent, rec.phase, rec.data, ctx.at);
      return;
    case 'loop.attempt':
    case 'loop.grant':
      countLoop(s, rec);
      return;
    case 'continuation.check':
      s.stmt(
        'INSERT INTO continuation_checks (judgment, extends, target, revision, ok, reason, inputs, rev) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(judgment) DO UPDATE SET extends = excluded.extends, target = excluded.target, revision = excluded.revision, ok = excluded.ok, reason = excluded.reason, inputs = excluded.inputs, rev = excluded.rev',
      ).run(rec.judgment, rec.extends, rec.target, rec.revision, rec.ok ? 1 : 0, rec.reason, rec.inputs, ctx.rev);
      return;
    case 'mission.block':
      s.stmt('INSERT INTO mission_blocks (mission, rev, record) VALUES (?, ?, ?) ON CONFLICT(mission) DO UPDATE SET rev = excluded.rev, record = excluded.record').run(rec.mission, ctx.rev, canonicalJson(rec));
      return;
    case 'task.queued':
      s.stmt(
        "INSERT INTO tasks (task, lineage, mission, card, state, queued_rev, queued_at, dispatch, by_task, updated_at) VALUES (?, ?, ?, ?, 'queued', ?, ?, NULL, NULL, ?) ON CONFLICT(task) DO UPDATE SET lineage = excluded.lineage, mission = excluded.mission, card = excluded.card, state = 'queued', queued_rev = excluded.queued_rev, queued_at = excluded.queued_at, dispatch = NULL, by_task = NULL, updated_at = excluded.updated_at",
      ).run(rec.task, rec.lineage, rec.mission, rec.card, ctx.rev, ctx.at, ctx.at);
      return;
    case 'task.dequeued':
      s.stmt('UPDATE tasks SET state = ?, by_task = ?, updated_at = ? WHERE task = ?').run(rec.reason, rec.by, ctx.at, rec.task);
      return;
    default:
      return;
  }
}

/** Set a rebuilt key of the `state` table (for extensions that keep a few derived values there). */
export function setState(s: Db, key: string, value: string): void {
  setKey(s, 'state', key, value);
}
