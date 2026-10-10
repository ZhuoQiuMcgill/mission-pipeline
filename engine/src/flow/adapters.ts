// Adapters from the flow ports (ports.ts) to the real engine pieces:
//
//   ledger     the scheduler's ledger client (IPC, the only writer, 6.1) and its indexed,
//              paged queries (flowEvents, recordsByKind, objectVersion, judgmentById,
//              flowMissions), the content store, and the scheduler's Alerts (control-plane copy
//              first, then the ledger, 3.9). Flow events are "flow.event" base records in the same
//              appendRecords op as the base records they come with; an op.executed goes through
//              commitProofOp with the append's events in the same transaction (6.1).
//   scheduler  an in-process Scheduler (src/scheduler/scheduler.ts): its task queue, the
//              Secretary's restart and grant, and the accepted launches' results. The program
//              actions the flows need beyond the queue (project snapshots, product versions from
//              an export, verification runs, history export) are injected: src/flow/actions.
//   evaluator  the evaluator's query socket (targets, deciding, judgments, ops).

import { existsSync, readFileSync } from 'node:fs';
import { join, normalize } from 'node:path';
import { canonicalJson } from '../common/hash.ts';
import { contentHash, type Generation, type LaunchId, type MissionId, type OpId, type Revision } from '../common/ids.ts';
import type { BaseRecord, BaseRecordKind, Committed, ListRef, LoopKind, SeatResultRecord } from '../common/records.ts';
import type { DecidingView, Label, TargetState } from '../evaluator/semantics.ts';
import type { UnitDemand } from '../exec/resources.ts';
import type { ContentStore } from '../ledger/content.ts';
import type { Alerts } from '../scheduler/alerts.ts';
import type { LoopState, SchedulerLedger } from '../scheduler/ledger.ts';
import type { LedgerReader } from '../scheduler/reader.ts';
import type { Scheduler } from '../scheduler/scheduler.ts';
import type { TaskSpec } from '../scheduler/tasks.ts';
import { seatCardEntry } from '../seat/cards/index.ts';
import type {
  AcceptedHandBack,
  FlowContent,
  FlowEvaluatorPort,
  FlowEvent,
  FlowEventInput,
  FlowEventRecord,
  FlowLedgerPort,
  FlowNotice,
  FlowSchedulerPort,
  FlowTask,
  FlowTaskStatus,
  LoopStatus,
  ProductRequest,
  ProductVersion,
  VerificationRun,
  VerifyRequest,
} from './ports.ts';

// ---------------------------------------------------------------- ledger

/** A refusal the flow retries on its next pass (the engine treats NOT_READY as transient). */
function retryable(message: string): Error {
  return Object.assign(new Error(message), { code: 'NOT_READY' });
}

function contentPort(store: ContentStore): FlowContent {
  return {
    put: (doc) => store.put(doc),
    get: (hash) => store.get(contentHash(hash)).toString('utf8'),
    putList: (items) => store.putList(items),
    getList: (ref: ListRef) => store.getList(ref),
  };
}

function loopStatus(lineage: string, loop: LoopKind, s: LoopState): LoopStatus {
  return { lineage, loop, attempts: s.attempts, allowed: s.allowed, exhausted: s.exhausted, reason: s.reason, secretaryGrantUsed: s.secretaryGrantUsed };
}

export interface LedgerAdapterDeps {
  readonly ledger: SchedulerLedger;
  /** Unused since the ledger answers indexed queries; kept for callers that still pass it. */
  readonly reader?: LedgerReader;
  readonly content: ContentStore;
  readonly alerts: Alerts;
  /** The current scheduler generation (writes are fenced by it, 6.3); null outside the scheduler. */
  readonly gen: () => Generation | null;
  /** Rows per query page (the ledger caps it at 10,000). */
  readonly pageSize?: number;
}

/** The ledger port over the ledger service's indexed queries (paged), never a whole-ledger scan. */
export function ledgerAdapter(d: LedgerAdapterDeps): FlowLedgerPort {
  const content = contentPort(d.content);
  const page = Math.max(1, Math.min(d.pageSize ?? 10_000, 10_000));
  const call = (method: Parameters<SchedulerLedger['client']['call']>[0], params: unknown): Promise<unknown> => d.ledger.client.call(method, params as never);
  /** Every row of a paged query: `after` is the last revision seen. */
  async function all<T extends { revision: number }>(q: (after: number) => Promise<readonly T[]>): Promise<T[]> {
    const out: T[] = [];
    let after = 0;
    for (;;) {
      const rows = await q(after);
      out.push(...rows);
      if (rows.length < page) return out;
      after = (rows.at(-1) as T).revision;
    }
  }
  const flowRecord = (e: FlowEventInput): FlowEventRecord => ({ kind: 'flow.event', mission: e.mission, line: e.line, event: e.event, key: e.key, body: d.content.put(canonicalJson(e.body)) });
  const port: FlowLedgerPort = {
    content,
    async append(op, entries) {
      // 6.1: op.executed is never a plain record: it goes through commitProofOp, with this append's events in its transaction
      const records = entries.records ?? [];
      const executed = records.filter((r): r is Extract<BaseRecord, { kind: 'op.executed' }> => r.kind === 'op.executed');
      if (executed.length > 1) throw new Error('one proof-conditioned operation per append');
      if (executed.length === 1) {
        const x = executed[0] as Extract<BaseRecord, { kind: 'op.executed' }>;
        await port.commitProofOp({ op, opId: x.op, asOf: x.asOf, events: entries.events ?? [] });
        const rest = records.filter((r) => r.kind !== 'op.executed');
        if (rest.length > 0) await d.ledger.appendRecords(`${op}:records`, d.gen(), rest);
        return;
      }
      const events = (entries.events ?? []).map(flowRecord);
      if (events.length + records.length > 0) await d.ledger.appendRecords(op, d.gen(), [...(events as unknown as BaseRecord[]), ...records]);
    },
    async commitProofOp(req) {
      const gen = d.gen();
      if (gen === null) throw retryable('a proof-conditioned operation is executed by the scheduler, which has no generation yet');
      const events = (req.events ?? []).map(flowRecord);
      try {
        await call('commitProofOp', { op: req.op, gen, opId: req.opId as OpId, asOf: req.asOf as Revision, ...(events.length > 0 ? { events } : {}) });
      } catch (e) {
        const code = (e as { code?: string }).code;
        // a newer revision was published meanwhile, or a stop covers it for now: read again next pass
        if (code === 'BELOW_FLOOR' || code === 'STOPPED') throw retryable(`${(e as Error).message} (${code})`);
        throw e;
      }
    },
    async events<B>(q: { readonly mission: MissionId; readonly line?: string; readonly event?: string }): Promise<readonly FlowEvent<B>[]> {
      const rows = await all(
        async (after) =>
          (await call('flowEvents', { mission: q.mission, ...(q.line !== undefined ? { line: q.line } : {}), ...(q.event !== undefined ? { event: q.event } : {}), after, limit: page })) as Array<{
            revision: number;
            mission: MissionId;
            line: string;
            event: string;
            key: string;
            body: string;
          }>,
      );
      return rows.map((r) => ({ revision: r.revision, mission: r.mission, line: r.line, event: r.event, key: r.key, body: JSON.parse(content.get(r.body)) as B }));
    },
    async records<K extends BaseRecordKind>(kinds: readonly K[], o: { readonly mission?: MissionId } = {}): Promise<ReadonlyArray<Committed<Extract<BaseRecord, { kind: K }>>>> {
      return (await all(async (after) => (await call('recordsByKind', { kinds: [...kinds], ...(o.mission !== undefined ? { mission: o.mission } : {}), after, limit: page })) as Committed[])) as unknown as ReadonlyArray<
        Committed<Extract<BaseRecord, { kind: K }>>
      >;
    },
    async objectVersion(object) {
      const c = (await call('objectVersion', { object })) as Committed | null;
      return c === null || c.record.kind !== 'object.version' ? null : c.record;
    },
    async judgment(judgment) {
      const c = (await call('judgmentById', { judgment })) as Committed | null;
      return c === null || c.record.kind !== 'judgment' ? null : c.record;
    },
    async loop(lineage, loop) {
      return loopStatus(lineage, loop, await d.ledger.loopState(lineage, loop));
    },
    async loopAttempt(req) {
      // the op names the attempt: the same op and payload again is the stored receipt; another
      // payload under the same op is a defect and is not swallowed (code review r1 #6)
      await d.ledger.appendRecords(req.op, d.gen(), [{ kind: 'loop.attempt', lineage: req.lineage, loop: req.loop, failureClass: req.failureClass ?? null, signature: req.signature }]);
      return loopStatus(req.lineage, req.loop, await d.ledger.loopState(req.lineage, req.loop));
    },
    async notify(n: FlowNotice) {
      await d.alerts.raise({
        category: n.category,
        wi: n.wi,
        key: `${n.mission}:${n.key}`,
        trigger: n.trigger,
        defaultAction: n.defaultAction,
        detail: { mission: n.mission, askUser: n.askUser ?? false, ...((typeof n.detail === 'object' && n.detail !== null ? n.detail : { detail: n.detail }) as object) },
      });
    },
    async missions() {
      return (await call('flowMissions', {})) as MissionId[];
    },
  };
  return port;
}

// ---------------------------------------------------------------- scheduler

/** The program actions beyond the queue that the flows need (7.1, 4.1, 4.2, 3.4). */
export interface ProgramActions {
  /** A read-only project snapshot (7.1) with accepted products laid over it (src/flow/actions). */
  snapshot(req: Parameters<FlowSchedulerPort['snapshot']>[0]): ReturnType<FlowSchedulerPort['snapshot']>;
  /** The commit generated from an export and the product version recorded with its contracts (4.2, 6.6, writeScope.ts; src/flow/actions). */
  product(req: ProductRequest): Promise<ProductVersion>;
  /** The program's verification runs on the canonical candidate (4.1, 7.2): evidence records (src/flow/actions). */
  verify(req: VerifyRequest): Promise<readonly VerificationRun[] | 'pending'>;
  /** Git history and run durations for the Architect (3.4); default: none. */
  history?(mission: MissionId): Promise<{ readonly gitLog: string; readonly runs: ReadonlyArray<{ readonly task: string; readonly seat: string; readonly durationMs: number; readonly costMicros: number }> }>;
}

export interface SchedulerAdapterOptions {
  /** Host and enclosure bytes reserved for every seat unit (6.5). Default 512 MiB and 528 MiB. */
  readonly hostBytes?: number;
  readonly enclosureBytes?: number;
}

const MiB = 1024 * 1024;

/** 6.5: a seat unit's whole-life demand from its card's limits and tool profile. */
export function seatDemand(card: FlowTask['card'], o: SchedulerAdapterOptions = {}): UnitDemand {
  const entry = seatCardEntry(card.seat);
  const limits = (card as unknown as { limits: { run: { memoryMax: number }; areaBytes: number; export: { maxLogicalBytes: number; maxFiles: number }; recoveryStateBytes: number; recoveryStateFiles?: number } }).limits;
  const runs = entry.toolProfile === 'write' || entry.toolProfile === 'read-rerun';
  const asyncEvidence = (card as { allowAsyncEvidence?: boolean }).allowAsyncEvidence === true;
  const resume = (card as { resume?: { state: string | null } }).resume;
  return {
    hostBytes: o.hostBytes ?? 512 * MiB,
    runPeakBytes: runs ? limits.run.memoryMax : 0,
    runParallelism: 1,
    areaBytes: limits.areaBytes,
    enclosureBytes: o.enclosureBytes ?? 528 * MiB,
    exportCaps: { maxLogicalBytes: limits.export.maxLogicalBytes, maxFiles: limits.export.maxFiles },
    recoveryState: asyncEvidence ? { maxLogicalBytes: limits.recoveryStateBytes, maxFiles: limits.recoveryStateFiles ?? 10_000 } : null,
    ...(resume !== undefined && resume.state !== null ? { resumesFromState: true } : {}),
  };
}

/** The scheduler TaskSpec of a flow task: a seat unit whose demand and host are derived by the scheduler (seats.ts). */
export function taskSpecOf(t: FlowTask, content: ContentStore, o: SchedulerAdapterOptions = {}): TaskSpec {
  const card = content.put(canonicalJson(t.card));
  const demand = seatDemand(t.card, o);
  return {
    task: t.task,
    lineage: t.lineage,
    mission: t.mission,
    capabilities: t.capabilities,
    priority: t.priority,
    dependsOn: [],
    paid: true,
    estimateMicros: t.estimateMicros,
    // derived from `seat` for seat units (tasks.ts): placeholders the scheduler does not use
    demand: { memoryBytes: demand.hostBytes, diskBytes: demand.exportCaps.maxLogicalBytes, inodes: demand.exportCaps.maxFiles },
    unit: { host: { argv: ['seat-host'], env: {}, cwd: '/' }, limits: { memoryMax: demand.hostBytes }, seatUnit: true, heartbeat: true },
    mode: t.mode,
    seat: { card, demand },
    ...(t.secretaryFor !== undefined ? { secretaryFor: { lineage: t.secretaryFor } } : {}),
    ...(t.binds !== undefined ? { binds: t.binds } : {}),
    ...(t.writeScope !== undefined ? { writeScope: t.writeScope } : {}),
    ...(t.changedLines !== undefined ? { changedLines: t.changedLines } : {}),
    ...(t.snapshot !== undefined ? { snapshot: t.snapshot } : {}),
    ...(t.afterClose !== undefined ? { afterClose: t.afterClose } : {}),
  };
}

export function schedulerAdapter(s: Scheduler, actions: ProgramActions, o: SchedulerAdapterOptions = {}): FlowSchedulerPort {
  const handBackOf = async (launch: LaunchId): Promise<AcceptedHandBack | null> => {
    const records = await s.ledger.pendingResults(launch);
    const seat = records.find((r): r is SeatResultRecord => r.kind === 'seat.result') ?? null;
    if (seat === null) return null;
    let result: unknown = null;
    if (seat.result !== null) {
      try {
        result = (JSON.parse(s.content.get(seat.result).toString('utf8')) as { result?: unknown }).result ?? null;
      } catch {
        result = null;
      }
    }
    // the session to resume after async evidence (6.2): on the record; the host's outcome file for older records
    let sessionId: string | null = (seat as { sessionId?: string | null }).sessionId ?? null;
    if (sessionId === null) {
      try {
        sessionId = (JSON.parse(readFileSync(join(s.opts.stateDir, 'units', launch, 'outcome.json'), 'utf8')) as { sessionId?: string | null }).sessionId ?? null;
      } catch {
        sessionId = null;
      }
    }
    return { launch, status: seat.status, result, resultHash: seat.result, export: seat.export, evidenceRequest: seat.evidenceRequest, recoveryState: seat.recoveryState, sessionId, records: records.filter((r) => r.kind !== 'seat.result') };
  };
  return {
    async submit(t) {
      if (s.tasks.get(t.task) !== undefined) return;
      await s.submitDurable(taskSpecOf(t, s.content, o));
    },
    async status(task): Promise<FlowTaskStatus | null> {
      const t = s.tasks.get(task);
      if (t === undefined) return null;
      const last = t.launches.at(-1);
      const handBack = last !== undefined && (t.state === 'done' || t.state === 'waiting-evidence') ? await handBackOf(last) : null;
      return { task, state: t.state, note: t.note, disposition: t.disposition, launches: [...t.launches], handBack };
    },
    cancel: (task) => s.cancelTask(task),
    async supersede(task, by) {
      await s.cancelTask(task);
      await s.submitDurable(taskSpecOf(by, s.content, o));
    },
    async restart(task, signature) {
      const v = await s.restartQuarantined(task, signature);
      if (v === null) return null;
      return { lineage: v.lineage, loop: v.loop, attempts: v.attempts, allowed: v.allowed, exhausted: v.exhausted, reason: v.reason, secretaryGrantUsed: v.state.secretaryGrantUsed };
    },
    grant: (req) => s.grant(req),
    snapshot: (req) => actions.snapshot(req),
    async findSymbol(req) {
      // read-only, no model: the file exists inside the snapshot and names the symbol
      const rel = normalize(req.file);
      if (rel.startsWith('..') || rel.startsWith('/') || rel.split('/').includes('.git')) return false;
      const p = join(req.snapshot, rel);
      if (!existsSync(p)) return false;
      try {
        return readFileSync(p, 'utf8').includes(req.symbol);
      } catch {
        return false;
      }
    },
    history: (mission) => (actions.history !== undefined ? actions.history(mission) : Promise.resolve({ gitLog: '', runs: [] })),
    product: (req) => actions.product(req),
    verify: (req) => actions.verify(req),
  };
}

// ---------------------------------------------------------------- evaluator

/** The evaluator's query socket (RpcClient satisfies it; the scheduler's EvaluatorQuery). */
export interface EvaluatorCaller {
  call(method: string, params?: unknown): Promise<unknown>;
}

export function evaluatorAdapter(q: EvaluatorCaller): FlowEvaluatorPort {
  return {
    async labels(ids) {
      const r = (await q.call('targets', { ids })) as { revision: number; states: Record<string, TargetState | null> };
      return { revision: r.revision, labels: Object.fromEntries(ids.map((i) => [i, (r.states[i]?.label ?? null) as Label | null])) };
    },
    async deciding(ids) {
      const r = (await q.call('deciding', { targets: ids })) as { revision: number; targets: Record<string, DecidingView | null> };
      return { revision: r.revision, views: Object.fromEntries(ids.map((i) => [i, r.targets[i] ?? null])) };
    },
    async judgments(ids) {
      const r = (await q.call('judgments', { ids })) as { revision: number; current: Record<string, boolean | null> };
      return { revision: r.revision, current: Object.fromEntries(ids.map((i) => [i, r.current[i] ?? null])) };
    },
    async ops(ids) {
      const r = (await q.call('ops', { ids })) as { revision: number; states: Record<string, { allProven: boolean; executedAsOf: number | null } | null> };
      return { revision: r.revision, states: Object.fromEntries(ids.map((i) => [i, r.states[i] === null || r.states[i] === undefined ? null : { allProven: r.states[i]!.allProven, executedAsOf: r.states[i]!.executedAsOf }])) };
    },
  };
}

/** All three adapters over one in-process scheduler. */
export function schedulerPorts(s: Scheduler, actions: ProgramActions, evaluator: EvaluatorCaller, o: SchedulerAdapterOptions = {}) {
  return {
    ledger: ledgerAdapter({ ledger: s.ledger, content: s.content, alerts: s.alerts, gen: () => s.generation }),
    scheduler: schedulerAdapter(s, actions, o),
    evaluator: evaluatorAdapter(evaluator),
  };
}
