// State tables as a projection of the log (design 10.1 rule 3; core review r2 F17).
//
// Every change the ledger service makes to a state table is the effect of one
// record it appends in the same transaction: the service appends the record,
// then applies `project` to it. Rebuilding replays the log and the journal
// through the same function, so the rebuilt tables equal the live ones by
// construction. Checks (stops, generations, conflicts...) happen in the service
// before the record is appended; `project` only applies effects.

import { canonicalJson, hashJson } from '../common/hash.ts';
import type { ContentHash } from '../common/ids.ts';
import { NO_PROGRESS_EXEMPT, type BaseRecord, type ListRef } from '../common/records.ts';
import { LedgerError } from './errors.ts';
import type { Store } from './store.ts';

/** Service events kept in the journal: they never create a revision (store.ts). */
export const JOURNAL_KINDS: ReadonlySet<string> = new Set(['op.receipt', 'evaluator.begun', 'evaluator.published', 'evaluator.health']);


export interface ProjectionContext {
  /** The record's revision; for a journal entry, the head it followed. */
  readonly rev: number;
  /** Its commit time (the log's committed_at): every timestamp column takes this value. */
  readonly at: number;
  /** Text of a content-store object the record refers to. */
  blob(hash: ContentHash): string;
  /** Items of a list the record refers to. */
  list(ref: ListRef): readonly string[];
}

/** The identity of a fact, written at most once with one payload. */
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
    case 'run.layer':
      // A JSON pair: legal ids contain ':', so "A:B" + "C" and "A" + "B:C" must not meet (core review r3 #15).
      return JSON.stringify([r.launch, r.run]);
    case 'claude-code.exit':
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

export function currentGeneration(s: Store): number {
  const row = s.stmt('SELECT COALESCE(MAX(gen), 0) AS gen FROM generations').get() as { gen: number };
  return row.gen;
}

/**
 * Loop counters per (lineage, loop), maintained with the records (6.5).
 * `no_progress_at`: the attempt count at which the same failure signature came
 * twice in a row (not for exempt loops). It stays until a grant, whatever
 * attempts follow: exhaustion is persistent (6.5 "耗尽之后"). A grant records
 * the attempt count it was made at (`attempts_at_grant`). The checks (one
 * Secretary grant per lineage, no attempt on an exhausted loop) are the
 * service's, before the record is appended.
 */
function countLoop(s: Store, r: Extract<BaseRecord, { kind: 'loop.attempt' } | { kind: 'loop.grant' }>): void {
  const row = s.stmt('SELECT attempts, by_class, last_signature, repeats, secretary_grants, extra, attempts_at_grant, no_progress_at FROM loops WHERE lineage = ? AND loop = ?').get(r.lineage, r.loop) as
    | { attempts: number; by_class: string; last_signature: string | null; repeats: number; secretary_grants: number; extra: number; attempts_at_grant: number | null; no_progress_at: number | null }
    | undefined;
  const cur = row ?? { attempts: 0, by_class: '{}', last_signature: null, repeats: 0, secretary_grants: 0, extra: 0, attempts_at_grant: null, no_progress_at: null };
  const upsert = s.stmt(
    'INSERT INTO loops (lineage, loop, attempts, by_class, last_signature, repeats, secretary_grants, extra, attempts_at_grant, no_progress_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(lineage, loop) DO UPDATE SET attempts = excluded.attempts, by_class = excluded.by_class, last_signature = excluded.last_signature, repeats = excluded.repeats, secretary_grants = excluded.secretary_grants, extra = excluded.extra, attempts_at_grant = excluded.attempts_at_grant, no_progress_at = excluded.no_progress_at',
  );
  if (r.kind === 'loop.attempt') {
    const byClass = JSON.parse(cur.by_class) as Record<string, number>;
    if (r.failureClass !== null) byClass[r.failureClass] = (byClass[r.failureClass] ?? 0) + 1;
    const attempts = cur.attempts + 1;
    const repeats = cur.last_signature === r.signature ? cur.repeats + 1 : 0;
    const noProgress = cur.no_progress_at ?? (repeats >= 1 && !NO_PROGRESS_EXEMPT.has(r.loop) ? attempts : null);
    upsert.run(r.lineage, r.loop, attempts, JSON.stringify(byClass), r.signature, repeats, cur.secretary_grants, cur.extra, cur.attempts_at_grant, noProgress);
  } else {
    upsert.run(r.lineage, r.loop, cur.attempts, cur.by_class, cur.last_signature, cur.repeats, cur.secretary_grants + (r.by === 'secretary' ? 1 : 0), cur.extra + r.extra, cur.attempts, null);
  }
}

function addTotals(s: Store, mission: string, spent: number, inflight: number): void {
  s.stmt('INSERT INTO spend_totals (mission, spent, inflight) VALUES (?, ?, ?) ON CONFLICT(mission) DO UPDATE SET spent = spent + excluded.spent, inflight = inflight + excluded.inflight').run(
    mission,
    spent,
    inflight,
  );
}

/** The mission a record belongs to, when it names one (a top-level `mission`, or an operation's scope). */
export function missionOf(rec: BaseRecord): string | null {
  const m = (rec as { mission?: unknown }).mission;
  if (typeof m === 'string') return m;
  if (rec.kind === 'op.pending') return rec.scope.mission;
  return null;
}

/** Apply the effects of one committed record to the state tables. */
export function project(s: Store, rec: BaseRecord, ctx: ProjectionContext): void {
  if (!JOURNAL_KINDS.has(rec.kind)) {
    // Reads by kind and mission (recordsByKind) use this index instead of scanning the log.
    const mission = missionOf(rec);
    if (mission !== null) s.stmt('INSERT INTO record_missions (rev, kind, mission) VALUES (?, ?, ?)').run(ctx.rev, rec.kind, mission);
  }
  const ident = identityOf(rec);
  if (ident !== null) {
    s.stmt('INSERT INTO facts (kind, id, payload_hash, rev) VALUES (?, ?, ?, ?)').run(rec.kind, ident, hashJson(rec), ctx.rev);
    if (rec.kind === 'op.pending') {
      s.stmt('INSERT INTO op_scopes (op, mission, capabilities) VALUES (?, ?, ?)').run(rec.op, rec.scope.mission, canonicalJson(rec.scope.capabilities));
    }
  }
  switch (rec.kind) {
    case 'stop.committed':
      s.stmt("INSERT INTO stops (stop, scope, words, state, requested_at, committed_at, narrows) VALUES (?, ?, ?, 'active', ?, ?, ?)").run(
        rec.stop,
        canonicalJson(rec.scope),
        rec.words,
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
    case 'generation.begun':
      s.stmt('INSERT INTO generations (gen, started_at) VALUES (?, ?)').run(rec.gen, ctx.at);
      return;
    case 'mission.state':
      s.stmt('INSERT INTO missions (mission, state) VALUES (?, ?) ON CONFLICT(mission) DO UPDATE SET state = excluded.state').run(rec.mission, rec.state);
      return;
    case 'launch.registered':
      s.stmt('INSERT INTO launches (launch, gen, mission, capabilities, created_at) VALUES (?, ?, ?, ?, ?)').run(rec.launch, rec.gen, rec.mission, canonicalJson(rec.capabilities), ctx.at);
      return;
    case 'launch.adopted':
      s.stmt('INSERT INTO adoptions (launch, gen, via, at) VALUES (?, ?, ?, ?)').run(rec.launch, rec.gen, rec.via, ctx.at);
      return;
    case 'result.pending':
      s.stmt('INSERT INTO pending_results (launch, op, records, submitted_at) VALUES (?, ?, ?, ?)').run(rec.launch, rec.op, ctx.blob(rec.records), ctx.at);
      return;
    case 'termination.proof':
      s.stmt('INSERT INTO proofs (launch, payload_hash, payload, registered_at) VALUES (?, ?, ?, ?)').run(rec.launch, hashJson(rec), canonicalJson(rec), ctx.at);
      return;
    case 'disposition':
      // The generation that decided it: the service checks it is the current one.
      s.stmt('INSERT INTO dispositions (launch, disposition, reason, gen, at) VALUES (?, ?, ?, ?, ?)').run(rec.launch, rec.disposition, rec.reason, currentGeneration(s), ctx.at);
      return;
    case 'intent.authorized': {
      const d = rec.delivery ?? null;
      s.stmt(
        "INSERT INTO intents (intent, op, kind, domain, launch, mission, capabilities, state, details, updated_at, delivery) VALUES (?, ?, ?, ?, ?, ?, ?, 'authorized', ?, ?, ?)",
      ).run(rec.intent, rec.op, rec.intentKind, rec.domain, rec.launch, rec.mission, canonicalJson(rec.capabilities), rec.details, ctx.at, d === null ? null : canonicalJson(d));
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
      if (rec.state === 'pending_verify') {
        s.stmt('UPDATE intents SET state = ?, executor = ?, updated_at = ? WHERE intent = ?').run(rec.state, canonicalJson(rec.executor), ctx.at, rec.intent);
      } else {
        s.stmt('UPDATE intents SET state = ?, updated_at = ? WHERE intent = ?').run(rec.state, ctx.at, rec.intent);
      }
      return;
    case 'cleanup.state':
      s.stmt(
        'INSERT INTO cleanups (launch, state, resources, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(launch) DO UPDATE SET state = excluded.state, resources = excluded.resources, updated_at = excluded.updated_at',
      ).run(rec.launch, rec.state, JSON.stringify(ctx.list(rec.resources)), ctx.at);
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
      ).run(rec.landing, rec.intent, rec.phase, ctx.blob(rec.data), ctx.at);
      return;
    case 'spend.limit':
      s.stmt('INSERT INTO spend_limits (mission, micros) VALUES (?, ?) ON CONFLICT(mission) DO UPDATE SET micros = excluded.micros').run(rec.mission, rec.micros);
      return;
    case 'spend.reserve':
      s.stmt('INSERT INTO spend (reservation, mission, launch, reserved) VALUES (?, ?, ?, ?)').run(rec.reservation, rec.mission, rec.launch, rec.micros);
      addTotals(s, rec.mission, 0, rec.micros);
      return;
    case 'spend.settle': {
      const row = s.stmt('SELECT mission, reserved FROM spend WHERE reservation = ?').get(rec.reservation) as { mission: string; reserved: number } | undefined;
      if (!row) throw new LedgerError('BAD_REQUEST', `no reservation ${rec.reservation}`);
      s.stmt('UPDATE spend SET settled = ?, how = ? WHERE reservation = ?').run(rec.micros, rec.how, rec.reservation);
      addTotals(s, row.mission, rec.micros, -row.reserved);
      return;
    }
    case 'loop.attempt':
    case 'loop.grant':
      countLoop(s, rec);
      return;
    case 'recovery.pause': {
      if (rec.state === 'cleared') {
        s.deleteState('recovery_pause');
        const d = s.getState('startup_decision');
        // The user's WI-12 answer stays with the cleared pause.
        if (d !== null) s.setState('startup_decision', canonicalJson({ ...(JSON.parse(d) as object), clearedAt: ctx.at, answer: rec.answer ?? null, answerOp: rec.op ?? null }));
        return;
      }
      if (rec.state === 'set' && s.getState('recovery_pause') === null) s.setState('recovery_pause', String(ctx.at));
      s.setState('startup_decision', canonicalJson({ state: rec.state, basis: rec.basis, at: ctx.at, clearedAt: null }));
      // The boots decided now are processed: their inbox slots may be reclaimed (v45 6.1 槽位协议).
      for (const b of rec.basis?.boots ?? []) s.stmt('INSERT OR IGNORE INTO inbox_boots (boot, rev, row) VALUES (?, ?, ?)').run(b.boot, ctx.rev, b.row);
      return;
    }
    case 'continuation.check':
      s.stmt(
        'INSERT INTO continuation_checks (judgment, extends, target, revision, ok, reason, inputs, rev) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(judgment) DO UPDATE SET extends = excluded.extends, target = excluded.target, revision = excluded.revision, ok = excluded.ok, reason = excluded.reason, inputs = excluded.inputs, rev = excluded.rev',
      ).run(rec.judgment, rec.extends, rec.target, rec.revision, rec.ok ? 1 : 0, rec.reason, rec.inputs, ctx.rev);
      return;
    case 'install.state':
      s.stmt(
        'INSERT INTO install_states (item, value, accepted, by_whom, detail, rev) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(item) DO UPDATE SET value = excluded.value, accepted = excluded.accepted, by_whom = excluded.by_whom, detail = excluded.detail, rev = excluded.rev',
      ).run(rec.item, rec.value, rec.accepted ? 1 : 0, rec.by, rec.detail, ctx.rev);
      return;
    case 'op.ended':
      s.stmt('INSERT INTO op_ends (op, reason, rev) VALUES (?, ?, ?)').run(rec.op, rec.reason, ctx.rev);
      return;
    case 'mission.block':
      s.stmt('INSERT INTO mission_blocks (mission, rev, record) VALUES (?, ?, ?) ON CONFLICT(mission) DO UPDATE SET rev = excluded.rev, record = excluded.record').run(
        rec.mission,
        ctx.rev,
        canonicalJson(rec),
      );
      return;
    case 'task.queued':
      s.stmt(
        "INSERT INTO tasks (task, lineage, mission, card, state, queued_rev, queued_at, launch, by_task, updated_at) VALUES (?, ?, ?, ?, 'queued', ?, ?, NULL, NULL, ?) ON CONFLICT(task) DO UPDATE SET lineage = excluded.lineage, mission = excluded.mission, card = excluded.card, state = 'queued', queued_rev = excluded.queued_rev, queued_at = excluded.queued_at, launch = NULL, by_task = NULL, updated_at = excluded.updated_at",
      ).run(rec.task, rec.lineage, rec.mission, rec.card, ctx.rev, ctx.at, ctx.at);
      return;
    case 'task.dequeued':
      s.stmt('UPDATE tasks SET state = ?, launch = ?, by_task = ?, updated_at = ? WHERE task = ?').run(rec.reason, rec.launch, rec.by, ctx.at, rec.task);
      return;
    // ---- journal
    case 'op.receipt':
      s.stmt('INSERT INTO ops (op, payload_hash, launch, response) VALUES (?, ?, ?, ?)').run(rec.op, rec.payloadHash, rec.launch, ctx.blob(rec.response));
      return;
    case 'evaluator.begun':
      s.setState('evaluator_epoch', String(rec.epoch));
      s.setState('evaluator_gen', String(rec.gen));
      s.setState('evaluator_identity', canonicalJson(rec.identity));
      return;
    case 'evaluator.published':
      s.setState('publication_floor', String(rec.revision));
      return;
    case 'evaluator.health':
      s.setState('evaluator_failures', String(rec.failures));
      s.setState('evaluator_fault', rec.fault ?? '');
      return;
    default:
      return;
  }
}
