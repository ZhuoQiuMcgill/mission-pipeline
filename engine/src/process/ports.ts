// The flows' ports on the project memory (design 4.1 §14 "Process"):
//
//   ledger     A1's domain functions inside `memory.write` (one write per append, idempotent by
//              its op id); its content port is the memory's data table. Flow events are
//              'flow.event' records in the same write as the base records they come with; an
//              op.executed goes through commitProofOp with the append's events. Notices are
//              'alert' records with their body as data, and an entry in the mission's
//              `notices.md` journal. Some flow events also write the documents people read
//              (requirements.md, decisions.md, plans, exploration versions: leaves, §3.1).
//   scheduler  the dispatch table: a submitted task is queued (its spec, the FlowTask with its
//              card, is a data value) and is a ready step for `mp pm next`; `mp pm dispatch`
//              claims it; the hand-back `mp seat <id> handback` recorded (recordHandback) is
//              what status() returns. Cancel, supersede, restart and grants through A1's queue
//              and loops. The program actions beyond the queue (snapshot, product, verify,
//              findSymbol, history) are actions.ts.
//   evaluator  A2's stored labels (decisionLabels, decidingViews, judgmentStates, opStates), each
//              call after the environment identity was observed (§6.5).

import { canonicalJson, sha256 } from '../common/hash.ts';
import { noticeAlertId } from '../flow/context.ts';
export { noticeAlertId } from '../flow/context.ts';
import type { AlertId, ContentHash, MissionId } from '../common/ids.ts';
import type { BaseRecord, BaseRecordKind, Committed, JudgmentRecord, ListRef, LoopKind, ObjectVersionRecord, TaskHandover } from '../common/records.ts';
import { decidingViews, decisionLabels, judgmentStates, labelStatus, opStates } from '../evaluator/index.ts';
import {
  appendRecords,
  commitProofOp,
  dequeueTask,
  dispatchInfo,
  factById,
  flowEventExists,
  flowEvents,
  flowMissions,
  LedgerError,
  listDispatches,
  loopState,
  markNotice,
  queueTask,
  raiseAlert,
  recordsByKind,
  stoppedFor,
  taskInfo,
  type Db,
  type DispatchInfo,
  type LoopState,
  type TaskInfo,
  type WriteTx,
} from '../memory/index.ts';
import { PLAN_LINE, REQUIREMENTS_LINE, SECRETARY_LINE } from '../flow/plandoc.ts';
import type {
  AcceptedHandBack,
  AppendGuard,
  FlowContent,
  FlowEvaluatorPort,
  FlowEvent,
  FlowEventInput,
  FlowLedgerPort,
  FlowNotice,
  FlowPorts,
  FlowSchedulerPort,
  FlowTask,
  FlowTaskStatus,
  LoopStatus,
} from '../flow/ports.ts';
import type { ProcessContext } from './context.ts';

/** A refusal the flow retries on its next pass (the engine treats NOT_READY as transient). */
function retryable(message: string): Error {
  return Object.assign(new Error(message), { code: 'NOT_READY' });
}

/** Codes that mean "not now": the labels are recomputing, a stop covers it for now, the memory is busy. */
const NOT_NOW = new Set(['BELOW_FLOOR', 'RECOMPUTING', 'STALE_REQUEST', 'STOPPED', 'BUSY']);

// ---------------------------------------------------------------- the task spec and the hand-back document

/** A task's spec as the queue keeps it (the card's hash names it): the FlowTask. */
export interface TaskSpecDoc extends FlowTask {
  readonly format: 'mp41.task.v1';
}

/** A task's spec, read back from the data table. */
export function readTaskSpec(db: Db & { readonly data?: unknown }, data: { text(h: string): string }, card: string): TaskSpecDoc {
  void db;
  return JSON.parse(data.text(card)) as TaskSpecDoc;
}

/**
 * What a hand-back records as its result (§3.2 item 11, a data value): the seat's structured
 * fields, the records accepted with it, the Constructor's candidate, and for a hand-back that
 * asked for evidence the request and the notes. `seat`: the hash of what the seat handed in, so
 * the same hand-back again is recognised (§5.3: one per dispatch).
 */
export interface HandbackDoc {
  readonly format: 'mp41.handback.v1';
  readonly kind: 'handed-back' | 'needs-evidence';
  readonly seat: string;
  readonly fields: unknown;
  readonly records: readonly BaseRecord[];
  readonly candidate: AcceptedHandBack['candidate'];
  readonly request: ContentHash | null;
  readonly notes: ContentHash | null;
  /** The pages of materials the dispatch read, and its runs (for reading the chain). */
  readonly runs: AcceptedHandBack['runs'];
  /** 5.2 part 5: the continuation judgment it carried was refused: the task goes to a full review. */
  readonly fullReview?: string;
}

/** The flow line the dispatch table's own bookkeeping is on (tasks given up outside the queue, dispatch reads and runs). */
export const DISPATCH_LINE = (dispatch: string): string => `dispatch:${dispatch}`;
export const TASKS_LINE = 'tasks';

/** The runs a dispatch had `mp` rerun, in order, with the environment identity each was recorded under (4.1 §6.5). */
export function dispatchRuns(db: Db, data: { text(h: string): string }, d: { readonly mission: string; readonly dispatch: string }): Array<{ run: string; completed: boolean; envLine?: string; envSnapshot?: string }> {
  return flowEvents(db, { mission: d.mission as MissionId, line: DISPATCH_LINE(d.dispatch), event: 'run' }).map((e) => {
    const b = JSON.parse(data.text(e.body)) as { run: string; completed: boolean; envLine?: string; envSnapshot?: string };
    return { run: b.run, completed: b.completed, ...(b.envLine !== undefined && b.envSnapshot !== undefined ? { envLine: b.envLine, envSnapshot: b.envSnapshot } : {}) };
  });
}

/** The material pages a dispatch read (`mp seat <id> read`), as `${material}#${page}` keys. */
export function dispatchReads(db: Db, d: { readonly mission: string; readonly dispatch: string }): Set<string> {
  return new Set(flowEvents(db, { mission: d.mission as MissionId, line: DISPATCH_LINE(d.dispatch), event: 'read', limit: 10_000 }).map((e) => e.key));
}

// ---------------------------------------------------------------- ledger

function contentPort(ctx: ProcessContext): FlowContent {
  const data = ctx.memory.data;
  return {
    put: (doc) => data.put(doc),
    get: (hash) => data.text(hash),
    putList: (items) => data.putList(items),
    getList: (ref: ListRef) => data.getList(ref),
  };
}

function loopStatus(lineage: string, loop: LoopKind, s: LoopState): LoopStatus {
  return { lineage, loop, attempts: s.attempts, allowed: s.allowed, exhausted: s.exhausted, reason: s.reason, secretaryGrantUsed: s.secretaryGrantUsed };
}

const PAGE = 5000;

/** Every row of a paged query (`after` is the last revision seen). */
function allPages<T extends { revision: number }>(q: (after: number) => readonly T[]): T[] {
  const out: T[] = [];
  let after = 0;
  for (;;) {
    const rows = q(after);
    out.push(...rows);
    if (rows.length < PAGE) return out;
    after = Number((rows.at(-1) as T).revision);
  }
}

function flowRecord(data: { put(doc: string): string }, e: FlowEventInput): BaseRecord {
  return { kind: 'flow.event', mission: e.mission, line: e.line, event: e.event, key: e.key, body: data.put(canonicalJson(e.body)) as ContentHash };
}

/** A path segment from an id (a leaf name): portable characters, and short. */
function segment(id: string): string {
  const s = id.replace(/[^A-Za-z0-9._-]/g, '-').replace(/^[^A-Za-z0-9_]+/, '').replace(/\.+$/, '');
  return s.length > 0 && s.length <= 100 ? s : `${s.slice(0, 80)}-${sha256(id).slice(0, 16)}`;
}

/**
 * The documents people read that some flow events stand for (§3.1 leaves): requirement item
 * versions with their quotes (requirements.md), decisions with their reasons (decisions.md), PM
 * plan versions, exploration product versions. Written in the same write as the event.
 */
function leavesOf(tx: WriteTx, events: readonly FlowEventInput[]): void {
  for (const e of events) {
    const m = e.mission;
    const b = e.body as Record<string, unknown>;
    if (e.line === REQUIREMENTS_LINE && e.event === 'item') {
      const src = b['source'] as { kind: string; words?: string; quote?: string; line?: string };
      tx.leaves.appendEntry(
        `missions/${m}/requirements.md`,
        `### ${String(b['version'])} (${String(b['type'])})\n\n${String(b['text'])}\n\n${src.kind === 'words' ? `> ${String(src.quote)}\n\n(${String(src.words)})` : `Rests on authorization ${String(src.line)}.`}`,
      );
    } else if (e.line === REQUIREMENTS_LINE && e.event === 'withdrawn') {
      tx.leaves.appendEntry(`missions/${m}/requirements.md`, `### ${String(b['line'])} withdrawn\n\n${String(b['reason'])}`);
    } else if (e.line === SECRETARY_LINE && (e.event === 'decision' || e.event === 'user-answer')) {
      const by = e.event === 'user-answer' ? 'the user' : String(b['by'] ?? 'the Secretary');
      tx.leaves.appendEntry(
        `missions/${m}/decisions.md`,
        `### ${e.key}: ${String(b['option'] ?? '')} (by ${by})\n\n${String(b['reason'] ?? '')}${b['instructions'] ? `\n\nInstructions: ${String(b['instructions'])}` : ''}${b['words'] ? `\n\n(${String(b['words'])})` : ''}`,
      );
    } else if (e.line === PLAN_LINE && e.event === 'pm-batch' && typeof b['doc'] === 'string' && typeof b['plan'] === 'string') {
      let doc: string;
      try {
        doc = JSON.stringify(JSON.parse(tx.data.text(b['doc'])), null, 2);
      } catch {
        continue;
      }
      tx.leaves.writeDocument(`missions/${m}/plans/${segment(b['plan'])}.md`, `# PM plan ${b['plan']} (batch ${String(b['batch'])})\n\n\`\`\`json\n${doc}\n\`\`\`\n`);
    } else if (e.line.startsWith('exploration:') && e.event === 'consumed' && (b['kind'] === 'author' || b['kind'] === 'interpretation') && b['changed'] === true && typeof b['version'] === 'string' && typeof b['content'] === 'string') {
      let text: string;
      try {
        text = tx.data.text(b['content']);
      } catch {
        continue;
      }
      tx.leaves.writeDocument(`missions/${m}/explorations/${segment(e.line.slice('exploration:'.length))}/${segment(b['version'])}.md`, `# ${b['version']}\n\n${text}\n`);
    }
  }
}

/** Detailed plan versions as plan documents (§3.1): the object's content rendered. */
function planLeaves(tx: WriteTx, records: readonly BaseRecord[]): void {
  for (const r of records) {
    if (r.kind !== 'object.version' || r.objectKind !== 'plan') continue;
    let doc: { format?: string };
    try {
      doc = JSON.parse(tx.data.text(r.content)) as { format?: string };
    } catch {
      continue;
    }
    // the PM plan's own leaf comes with its batch (leavesOf)
    if (doc.format !== 'mp4.detailed-plan.v1') continue;
    tx.leaves.writeDocument(`missions/${r.mission}/plans/${segment(r.object)}.md`, `# Detailed plan ${r.object}\n\n\`\`\`json\n${JSON.stringify(doc, null, 2)}\n\`\`\`\n`);
  }
}

/** Raise a notice inside a write (once per id): the alert record and its journal entry in the mission's notices.md. */
export function raiseNotice(tx: WriteTx, n: FlowNotice): boolean {
  const alert = noticeAlertId(n);
  if (tx.stmt("SELECT 1 FROM log WHERE kind = 'alert' AND json_extract(record, '$.alert') = ? LIMIT 1").get(alert)) return false;
  const body = tx.data.put(canonicalJson({ mission: n.mission, category: n.category, wi: n.wi, key: n.key, trigger: n.trigger, defaultAction: n.defaultAction, detail: n.detail ?? null, askUser: n.askUser ?? false }));
  raiseAlert(tx, { alert: alert as AlertId, category: n.category, ...(n.wi !== null ? { wi: n.wi } : { informational: true as const }), body });
  tx.leaves.appendEntry(`missions/${n.mission}/notices.md`, `### ${n.category}${n.wi !== null ? ` (${n.wi})` : ''}\n\n${n.trigger}\n\nDefault action: ${n.defaultAction}${n.askUser === true ? '\n\nAsk the user.' : ''}`);
  return true;
}

export class MemoryFlowLedger implements FlowLedgerPort {
  readonly content: FlowContent;
  private readonly ctx: ProcessContext;

  constructor(ctx: ProcessContext) {
    this.ctx = ctx;
    this.content = contentPort(ctx);
  }

  private get memory() {
    return this.ctx.memory;
  }

  async append(op: string, entries: { readonly events?: readonly FlowEventInput[]; readonly records?: readonly BaseRecord[]; readonly guard?: AppendGuard }): Promise<void> {
    const records = entries.records ?? [];
    const events = entries.events ?? [];
    // 6.1: op.executed is never a plain record: it goes through commitProofOp, with this append's events in its transaction
    const executed = records.filter((r): r is Extract<BaseRecord, { kind: 'op.executed' }> => r.kind === 'op.executed');
    if (executed.length > 1) throw new Error('one proof-conditioned operation per append');
    if (executed.length === 1) {
      const x = executed[0] as Extract<BaseRecord, { kind: 'op.executed' }>;
      await this.commitProofOp({ op, opId: x.op, asOf: x.asOf, events });
      const rest = records.filter((r) => r.kind !== 'op.executed');
      if (rest.length > 0) await this.append(`${op}:records`, { records: rest });
      return;
    }
    if (events.length + records.length === 0) return;
    const payload = { events: events.map((e) => ({ ...e, body: canonicalJson(e.body) })), records };
    const guard = entries.guard;
    this.memory.write({ op, payload }, (tx) => {
      // the append's precondition, inside its own write (nothing is written when it fails)
      if (guard !== undefined && guard.absent.some((g) => flowEventExists(tx, g))) throw Object.assign(new Error(guard.message), { code: guard.code });
      appendRecords(tx, [...events.map((e) => flowRecord(tx.data, e)), ...records.filter((r) => r.kind !== 'notice.delivery')]);
      for (const r of records) if (r.kind === 'notice.delivery') markNotice(tx, r);
      leavesOf(tx, events);
      planLeaves(tx, records);
    });
  }

  async commitProofOp(req: { readonly op: string; readonly opId: string; readonly asOf: number; readonly events?: readonly FlowEventInput[] }): Promise<void> {
    // a decision that reads labels: this process observes the environment identity first (§6.5)
    this.ctx.environment();
    const events = req.events ?? [];
    try {
      this.memory.write({ op: req.op, payload: { opId: req.opId, events: events.map((e) => ({ ...e, body: canonicalJson(e.body) })) } }, (tx) => {
        commitProofOp(tx, { opId: req.opId as never, events: events.map((e) => flowRecord(tx.data, e)) });
        leavesOf(tx, events);
      });
    } catch (e) {
      const code = (e as { code?: string }).code ?? '';
      if (NOT_NOW.has(code)) throw retryable(`${(e as Error).message} (${code})`);
      throw e;
    }
  }

  async events<B = unknown>(q: { readonly mission: MissionId; readonly line?: string; readonly event?: string }): Promise<readonly FlowEvent<B>[]> {
    const data = this.memory.data;
    return this.memory.read((db) =>
      allPages((after) => flowEvents(db, { mission: q.mission, ...(q.line !== undefined ? { line: q.line } : {}), ...(q.event !== undefined ? { event: q.event } : {}), after, limit: PAGE })).map((r) => ({
        revision: Number(r.revision),
        mission: r.mission,
        line: r.line,
        event: r.event,
        key: r.key,
        body: JSON.parse(data.text(r.body)) as B,
      })),
    );
  }

  async records<K extends BaseRecordKind>(kinds: readonly K[], o: { readonly mission?: MissionId } = {}): Promise<ReadonlyArray<Committed<Extract<BaseRecord, { kind: K }>>>> {
    return this.memory.read((db) =>
      allPages((after) => recordsByKind(db, { kinds: [...kinds], ...(o.mission !== undefined ? { mission: o.mission } : {}), after, limit: PAGE })).map((c) => ({ revision: c.revision, record: c.record })),
    ) as unknown as ReadonlyArray<Committed<Extract<BaseRecord, { kind: K }>>>;
  }

  async objectVersion(object: string): Promise<ObjectVersionRecord | null> {
    const c = this.memory.read((db) => factById(db, 'object.version', object));
    return c === null ? null : (c.record as ObjectVersionRecord);
  }

  async judgment(judgment: string): Promise<JudgmentRecord | null> {
    const c = this.memory.read((db) => factById(db, 'judgment', judgment));
    return c === null ? null : (c.record as JudgmentRecord);
  }

  async loop(lineage: string, loop: LoopKind): Promise<LoopStatus> {
    return loopStatus(lineage, loop, this.memory.read((db) => loopState(db, lineage, loop)));
  }

  async loopAttempt(req: { readonly op: string; readonly lineage: string; readonly loop: LoopKind; readonly signature: string; readonly failureClass?: string | null }): Promise<LoopStatus> {
    // the op names the attempt: the same op and payload again is its receipt (no double count)
    await this.append(req.op, { records: [{ kind: 'loop.attempt', lineage: req.lineage, loop: req.loop, failureClass: req.failureClass ?? null, signature: req.signature }] });
    return this.loop(req.lineage, req.loop);
  }

  async notify(n: FlowNotice): Promise<void> {
    const alert = noticeAlertId(n);
    if (this.memory.read((db) => Boolean(db.stmt("SELECT 1 FROM log WHERE kind = 'alert' AND json_extract(record, '$.alert') = ? LIMIT 1").get(alert)))) return;
    this.memory.write({ op: `notice:${alert}`, payload: { alert } }, (tx) => {
      raiseNotice(tx, n);
    });
  }

  async missions(): Promise<readonly MissionId[]> {
    return this.memory.read((db) => flowMissions(db));
  }

  async missionClosed(mission: MissionId): Promise<boolean> {
    return this.memory.read((db) => (db.stmt('SELECT state FROM missions WHERE mission = ?').get(mission) as { state: string } | undefined)?.state === 'closed');
  }
}

// ---------------------------------------------------------------- the dispatch table

/** The handback document of a dispatch, or null. */
export function handbackDoc(data: { text(h: string): string }, d: DispatchInfo): HandbackDoc | null {
  if (d.result === null) return null;
  try {
    const doc = JSON.parse(data.text(d.result)) as HandbackDoc;
    return doc.format === 'mp41.handback.v1' ? doc : null;
  } catch {
    return null;
  }
}

function acceptedOf(d: DispatchInfo, doc: HandbackDoc): AcceptedHandBack {
  return {
    dispatch: d.dispatch,
    status: doc.kind,
    result: doc.fields,
    resultHash: d.result,
    candidate: doc.candidate,
    evidenceRequest: doc.request,
    notes: doc.notes,
    report: d.reportLeaf,
    runs: doc.runs,
    records: doc.records,
  };
}

/** A task given up outside the queue (a hand-back after a stop, used-up re-dispatches, a seat waiting for evidence): the dispatch table's own mark. */
function givenUp(db: Db, t: TaskInfo): boolean {
  return flowEvents(db, { mission: t.mission, line: TASKS_LINE, event: 'given-up' }).some((e) => e.key === t.task && Number(e.revision) > Number(t.queuedRevision));
}

/** The loop a released dispatch's re-dispatch counts on (decision 15). */
export const REDISPATCH_LOOP: LoopKind = 'quarantine-restart';

/** A task's state as the flows see it (FlowTaskStatus), in one read. */
export function taskStatus(db: Db, data: { text(h: string): string }, task: string): FlowTaskStatus | null {
  const t = taskInfo(db, task);
  if (t === null) return null;
  const dispatches = listDispatches(db, { task, limit: 1000 }).map((d) => d.dispatch);
  const base = { task, dispatches };
  if (t.state === 'queued') return { ...base, state: 'queued', note: dispatches.length > 0 ? `queued again after ${dispatches.length} dispatch(es)` : null, disposition: null, handBack: null };
  if (t.state === 'cancelled' || t.state === 'superseded') return { ...base, state: 'abandoned', note: t.state === 'superseded' ? `superseded by ${t.by ?? '?'}` : 'cancelled', disposition: null, handBack: null };
  const d = t.dispatch === null ? null : dispatchInfo(db, t.dispatch);
  if (d === null) return { ...base, state: 'queued', note: null, disposition: null, handBack: null };
  if (givenUp(db, t)) return { ...base, state: 'abandoned', note: 'given up', disposition: null, handBack: null };
  if (d.state === 'in-flight') return { ...base, state: 'running', note: `dispatch ${d.dispatch} in flight`, disposition: null, handBack: null };
  if (d.state === 'released') {
    const loop = loopState(db, t.lineage, REDISPATCH_LOOP);
    return { ...base, state: 'exhausted', note: `dispatch ${d.dispatch} released ${d.released ?? ''}; re-dispatches used up (${loop.attempts}/${loop.allowed})`, disposition: null, handBack: null, loop: REDISPATCH_LOOP };
  }
  if (d.handback === 'after-stop') return { ...base, state: 'needs-disposition', note: `the hand-back of ${d.dispatch} arrived after a stop and was not accepted`, disposition: 'stop', handBack: null };
  const doc = handbackDoc(data, d);
  if (doc === null) return { ...base, state: 'needs-disposition', note: `the hand-back of ${d.dispatch} has no result`, disposition: null, handBack: null };
  if (doc.fullReview !== undefined) return { ...base, state: 'needs-disposition', note: doc.fullReview, disposition: 'full-review', handBack: null };
  const hb = acceptedOf(d, doc);
  return { ...base, state: doc.kind === 'needs-evidence' ? 'waiting-evidence' : 'done', note: doc.kind === 'needs-evidence' ? 'needs evidence' : 'accepted', disposition: null, handBack: hb };
}

/**
 * Who hands a task over (4.1 §3.2, U-13): the flow's own hint, else the advance's trigger (the
 * hand-back or the PM command); the dispatch is the one whose hand-back of that task was accepted.
 */
function handoverOf(db: Db, trigger: ProcessContext['handover'], task: FlowTask): TaskHandover {
  const h = task.handover;
  const from = h?.from !== undefined ? h.from : (trigger?.task ?? null);
  let dispatch: string | null = null;
  if (from !== null) {
    if (from === trigger?.task) dispatch = trigger.dispatch;
    else dispatch = listDispatches(db, { task: from, state: 'handed-back', limit: 1000 }).filter((d) => d.handback === 'accepted').at(-1)?.dispatch ?? null;
  }
  const target = (task.card as { target?: unknown }).target;
  const objects = h?.objects ?? [...new Set([...(task.binds ?? []), ...(typeof target === 'string' ? [target] : [])])];
  const step = h?.step ?? trigger?.step ?? 'the process advanced (mp pm next)';
  return { dispatch, task: from, objects: objects.slice(0, 32), step: step.slice(0, 300) };
}

export class MemoryFlowScheduler implements FlowSchedulerPort {
  private readonly ctx: ProcessContext;

  constructor(ctx: ProcessContext) {
    this.ctx = ctx;
  }

  private get memory() {
    return this.ctx.memory;
  }

  async submit(task: FlowTask): Promise<void> {
    if (this.memory.read((db) => taskInfo(db, task.task)) !== null) return;
    const spec: TaskSpecDoc = { format: 'mp41.task.v1', ...task };
    const json = canonicalJson(spec);
    this.memory.write({ op: `task:${task.task}`, payload: { spec: sha256(json) } }, (tx) => {
      if (taskInfo(tx, task.task) !== null) return;
      queueTask(tx, { task: task.task, lineage: task.lineage, mission: task.mission, card: tx.data.put(json) as ContentHash, queuedBy: handoverOf(tx, this.ctx.handover, task) });
    });
  }

  async status(task: string): Promise<FlowTaskStatus | null> {
    const data = this.memory.data;
    return this.memory.read((db) => taskStatus(db, data, task));
  }

  async cancel(task: string): Promise<boolean> {
    return this.memory.write({}, (tx) => {
      const t = taskInfo(tx, task);
      if (t === null) return false;
      if (t.state === 'queued') {
        dequeueTask(tx, { task, reason: 'cancelled' });
        return true;
      }
      if (t.state !== 'dispatched' || t.dispatch === null) return false;
      if (dispatchInfo(tx, t.dispatch)?.state === 'in-flight' || givenUp(tx, t)) return false;
      appendRecords(tx, [flowRecord(tx.data, { mission: t.mission, line: TASKS_LINE, event: 'given-up', key: task, body: { task, dispatch: t.dispatch } })]);
      return true;
    });
  }

  async supersede(task: string, by: FlowTask): Promise<void> {
    this.memory.write({}, (tx) => {
      const t = taskInfo(tx, task);
      if (t?.state === 'queued') dequeueTask(tx, { task, reason: 'superseded', by: by.task });
      else if (t?.state === 'dispatched' && t.dispatch !== null && dispatchInfo(tx, t.dispatch)?.state !== 'in-flight' && !givenUp(tx, t)) {
        appendRecords(tx, [flowRecord(tx.data, { mission: t.mission, line: TASKS_LINE, event: 'given-up', key: task, body: { task, supersededBy: by.task } })]);
      }
    });
    await this.submit(by);
  }

  async restart(task: string, signature: string): Promise<LoopStatus | null> {
    return this.memory.write({}, (tx) => {
      const t = taskInfo(tx, task);
      if (t === null || t.state !== 'dispatched' || t.dispatch === null) return null;
      const d = dispatchInfo(tx, t.dispatch);
      // only a hand-back that came after a stop, once the stop no longer covers the task (6.4: never restarted while it holds)
      if (d === null || d.handback !== 'after-stop' || stoppedFor(tx, d.tag)) return null;
      const pre = loopState(tx, t.lineage, REDISPATCH_LOOP);
      if (pre.exhausted) return loopStatus(t.lineage, REDISPATCH_LOOP, pre);
      appendRecords(tx, [{ kind: 'loop.attempt', lineage: t.lineage, loop: REDISPATCH_LOOP, failureClass: null, signature: `restart:${t.dispatch}:${signature}`.slice(0, 400) }]);
      queueTask(tx, { task, lineage: t.lineage, mission: t.mission, card: t.card });
      return loopStatus(t.lineage, REDISPATCH_LOOP, loopState(tx, t.lineage, REDISPATCH_LOOP));
    });
  }

  async grant(req: { readonly op: string; readonly lineage: string; readonly loop: LoopKind; readonly by: 'secretary' | 'user'; readonly extra: number; readonly reason: string }): Promise<{ readonly granted: boolean; readonly why?: string }> {
    if (req.by === 'secretary' && (req.extra < 1 || req.extra > 2)) return { granted: false, why: 'too-many' };
    try {
      this.memory.write({ op: req.op, payload: { lineage: req.lineage, loop: req.loop, by: req.by, extra: req.extra } }, (tx) => {
        const reason = tx.data.put(canonicalJson({ format: 'mp4.loop-grant-reason.v2', reason: req.reason, by: req.by })) as ContentHash;
        appendRecords(tx, [{ kind: 'loop.grant', lineage: req.lineage, loop: req.loop, by: req.by, extra: req.extra, reason }]);
        // tasks of the lineage whose re-dispatches were used up are ready again (6.5: the loop runs again)
        if (req.loop === REDISPATCH_LOOP && !loopState(tx, req.lineage, REDISPATCH_LOOP).exhausted) {
          for (const r of tx.stmt("SELECT task FROM tasks WHERE lineage = ? AND state = 'dispatched'").all(req.lineage) as Array<{ task: string }>) {
            const t = taskInfo(tx, r.task);
            if (t === null || t.dispatch === null || givenUp(tx, t)) continue;
            if (dispatchInfo(tx, t.dispatch)?.state !== 'released') continue;
            queueTask(tx, { task: t.task, lineage: t.lineage, mission: t.mission, card: t.card });
          }
        }
      });
    } catch (e) {
      if (e instanceof LedgerError && e.code === 'GRANT_LIMIT') return { granted: false, why: 'secretary-already-granted' };
      throw e;
    }
    return { granted: true };
  }

  composition(products: readonly string[]): ReturnType<FlowSchedulerPort['composition']> {
    return this.ctx.actions().composition(products);
  }

  startHolds(product: string): ReturnType<FlowSchedulerPort['startHolds']> {
    return this.ctx.actions().startHolds(product);
  }

  snapshot(req: Parameters<FlowSchedulerPort['snapshot']>[0]): ReturnType<FlowSchedulerPort['snapshot']> {
    return this.ctx.actions().snapshot(req);
  }

  findSymbol(req: Parameters<FlowSchedulerPort['findSymbol']>[0]): ReturnType<FlowSchedulerPort['findSymbol']> {
    return this.ctx.actions().findSymbol(req);
  }

  history(mission: MissionId): ReturnType<FlowSchedulerPort['history']> {
    return this.ctx.actions().history(mission);
  }

  product(req: Parameters<FlowSchedulerPort['product']>[0]): ReturnType<FlowSchedulerPort['product']> {
    return this.ctx.actions().product(req);
  }

  rebind(req: Parameters<FlowSchedulerPort['rebind']>[0]): ReturnType<FlowSchedulerPort['rebind']> {
    return this.ctx.actions().rebind(req);
  }

  verify(req: Parameters<FlowSchedulerPort['verify']>[0]): ReturnType<FlowSchedulerPort['verify']> {
    return this.ctx.actions().verify(req);
  }
}

// ---------------------------------------------------------------- the evaluator port (A2's stored labels)

export class MemoryFlowEvaluator implements FlowEvaluatorPort {
  private readonly ctx: ProcessContext;

  constructor(ctx: ProcessContext) {
    this.ctx = ctx;
  }

  /** Every deciding read observes the environment identity first (§6.5: a changed identity is recorded, its runs need a rerun). */
  private read<T>(fn: (db: Db) => T): T {
    this.ctx.environment();
    return this.ctx.memory.read(fn);
  }

  async labels(ids: readonly string[]) {
    return this.read((db) => ({ revision: labelStatus(db).revision, labels: decisionLabels(db, ids) }));
  }

  async deciding(ids: readonly string[]) {
    return this.read((db) => {
      const v = decidingViews(db, ids);
      return { revision: v.status.revision, views: Object.fromEntries(ids.map((i) => [i, v.views.get(i) ?? null])) };
    });
  }

  async judgments(ids: readonly string[]) {
    return this.read((db) => {
      const j = judgmentStates(db, ids);
      return { revision: j.status.revision, current: j.current };
    });
  }

  async ops(ids: readonly string[]) {
    return this.read((db) => {
      const o = opStates(db, ids);
      return { revision: o.status.revision, states: Object.fromEntries(ids.map((i) => [i, o.states[i] === null || o.states[i] === undefined ? null : { allProven: o.states[i]!.allProven, executedAsOf: o.states[i]!.executedAsOf as number | null }])) };
    });
  }
}

/** The three ports over one process context. */
export function memoryFlowPorts(ctx: ProcessContext): FlowPorts {
  return { ledger: new MemoryFlowLedger(ctx), scheduler: new MemoryFlowScheduler(ctx), evaluator: new MemoryFlowEvaluator(ctx), now: ctx.now };
}
