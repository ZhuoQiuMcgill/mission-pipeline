// In-memory fakes of the flow ports (src/flow/ports.ts), for tests and for scripted runs
// without models. They keep the rules that matter to the flows:
//   - FakeFlowLedger: one revision counter for flow events and base records; appends are
//     idempotent by op (same payload: no-op; another payload: OP_CONFLICT) and by event
//     identity (FACT_CONFLICT on another body); base records are validated as the ledger does
//     (validateRecord) and their lists must be in the content store; loop counts per lineage
//     with caps (LOOP_CAPS), no-progress detection and the Secretary's single grant (6.5).
//   - FakeFlowScheduler: a task table driven by the test (`run`), which plays the seat host:
//     a hand-back is checked by the card kind's program rules and becomes its records, as the
//     host submits them (the Reviewer's judgment and findings through src/seat/results.ts);
//     product versions and verification runs are recorded like the program would.
//   - FakeFlowEvaluator: the real incremental derivation (src/evaluator/incremental.ts) over
//     the fake ledger's base records, so labels and positions follow design 5.2 exactly.

import { canonicalJson, sha256 } from '../common/hash.ts';
import type { ContentHash, LaunchId, MissionId, Revision } from '../common/ids.ts';
import {
  EVALUATOR_INPUT_KINDS,
  LOOP_CAPS,
  NO_PROGRESS_EXEMPT,
  type BaseRecord,
  type BaseRecordKind,
  type Committed,
  type ListRef,
  type LoopKind,
  type SeatResultRecord,
} from '../common/records.ts';
import { validateRecord } from '../common/validate.ts';
import { IncrementalDerivation } from '../evaluator/incremental.ts';
import type { ResolvedCommitted, ResolvedRecord } from '../evaluator/semantics.ts';
import type { ContentStore } from '../ledger/content.ts';
import type { ReviewerCard } from '../seat/card.ts';
import { handBackProblems, handBackRecords, seatCardEntry } from '../seat/cards/index.ts';
import { materialPageKey, type MaterialRef } from '../seat/cards/common.ts';
import { idPart } from './context.ts';
import { citedEvidence, findingRecords, judgmentRecord, type ReviewerResult } from '../seat/results.ts';
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
  FlowTaskState,
  FlowTaskStatus,
  LoopStatus,
  ProductRequest,
  ProductVersion,
  VerificationRun,
  VerifyRequest,
} from './ports.ts';

export class FlowPortError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

// ---------------------------------------------------------------- content

export class FakeContent implements FlowContent {
  readonly docs = new Map<string, string>();

  put(doc: string): ContentHash {
    const h = sha256(doc);
    this.docs.set(h, doc);
    return h;
  }

  get(hash: string): string {
    const d = this.docs.get(hash);
    if (d === undefined) throw new FlowPortError('NOT_FOUND', `no content ${hash}`);
    return d;
  }

  has(hash: string): boolean {
    return this.docs.has(hash);
  }

  putList(items: readonly string[]): ListRef {
    return { hash: this.put(JSON.stringify(items)), count: items.length };
  }

  getList(ref: ListRef): string[] {
    const v = JSON.parse(this.get(ref.hash)) as unknown;
    if (!Array.isArray(v) || v.length !== ref.count) throw new FlowPortError('BAD_LIST', `list ${ref.hash} does not match its reference`);
    return v as string[];
  }
}

// ---------------------------------------------------------------- ledger

interface LoopRow {
  attempts: number;
  extra: number;
  secretaryGrants: number;
  lastSignature: string | null;
  noProgress: boolean;
}

function isListRef(v: unknown): v is ListRef {
  return Boolean(v) && typeof v === 'object' && typeof (v as ListRef).hash === 'string' && typeof (v as ListRef).count === 'number';
}

export class FakeFlowLedger implements FlowLedgerPort {
  readonly content = new FakeContent();
  private rev = 0;
  readonly base: Array<Committed<BaseRecord>> = [];
  readonly flow: Array<{ revision: number; record: FlowEventRecord }> = [];
  private readonly ops = new Map<string, string>();
  private readonly eventBodies = new Map<string, string>();
  private readonly loops = new Map<string, LoopRow>();
  readonly notices: FlowNotice[] = [];
  /** Every append, in order (op ids), for tests. */
  readonly appended: string[] = [];
  /** Tests: make the next append with an op matching this predicate fail (a lost write). */
  failNext: ((op: string) => boolean) | null = null;

  get head(): number {
    return this.rev;
  }

  async append(op: string, entries: { readonly events?: readonly FlowEventInput[]; readonly records?: readonly BaseRecord[] }): Promise<void> {
    if (this.failNext?.(op)) {
      this.failNext = null;
      throw new FlowPortError('UNAVAILABLE', `injected failure of ${op}`);
    }
    const events = entries.events ?? [];
    const records = entries.records ?? [];
    const payload = sha256(canonicalJson({ events: events.map((e) => ({ ...e, body: canonicalJson(e.body) })), records }));
    const prior = this.ops.get(op);
    if (prior !== undefined) {
      if (prior !== payload) throw new FlowPortError('OP_CONFLICT', `op ${op} was committed with another payload`);
      return;
    }
    // check everything before committing anything (atomic)
    const fresh: Array<{ id: string; ev: FlowEventInput; body: ContentHash }> = [];
    for (const e of events) {
      const body = this.content.put(canonicalJson(e.body));
      // the ledger's own rules for the record (common/validate.ts "flow.event")
      validateRecord({ kind: 'flow.event', mission: e.mission, line: e.line, event: e.event, key: e.key, body } as unknown as BaseRecord);
      const id = canonicalJson([e.mission, e.line, e.event, e.key]);
      const known = this.eventBodies.get(id);
      if (known !== undefined) {
        if (known !== body) throw new FlowPortError('FACT_CONFLICT', `flow event ${id} exists with another body`);
        continue;
      }
      if (fresh.some((f) => f.id === id)) throw new FlowPortError('FACT_CONFLICT', `flow event ${id} twice in one op`);
      fresh.push({ id, ev: e, body });
    }
    // op.executed goes through the proof-operation check with the append's events, as in the real adapter (6.1)
    const executed = records.filter((r): r is Extract<BaseRecord, { kind: 'op.executed' }> => r.kind === 'op.executed');
    if (executed.length > 1) throw new FlowPortError('BAD_REQUEST', 'one proof-conditioned operation per append');
    if (executed.length === 1) {
      const rest = records.filter((r) => r.kind !== 'op.executed');
      await this.commitProofOp({ op, opId: (executed[0] as { op: string }).op, asOf: (executed[0] as { asOf: number }).asOf, events });
      if (rest.length > 0) await this.append(`${op}:records`, { records: rest });
      return;
    }
    for (const r of records) this.check(r);
    for (const f of fresh) {
      this.eventBodies.set(f.id, f.body);
      this.flow.push({ revision: ++this.rev, record: { kind: 'flow.event', mission: f.ev.mission, line: f.ev.line, event: f.ev.event, key: f.ev.key, body: f.body } });
    }
    for (const r of records) {
      this.base.push({ revision: ++this.rev as Revision, record: r });
      this.applyLoop(r);
    }
    this.ops.set(op, payload);
    this.appended.push(op);
  }

  /** Commit base records the way acceptance does (no op): the fake scheduler uses it. */
  commit(records: readonly BaseRecord[]): void {
    for (const r of records) this.check(r);
    for (const r of records) {
      this.base.push({ revision: ++this.rev as Revision, record: r });
      this.applyLoop(r);
    }
  }

  /** Loop counters follow the committed loop records, as the ledger's projection does (6.5). */
  private applyLoop(r: BaseRecord): void {
    if (r.kind === 'loop.attempt') {
      const row = this.row(r.lineage, r.loop);
      row.attempts++;
      if (!NO_PROGRESS_EXEMPT.has(r.loop) && row.lastSignature !== null && row.lastSignature === r.signature) row.noProgress = true;
      row.lastSignature = r.signature;
    } else if (r.kind === 'loop.grant') {
      const row = this.row(r.lineage, r.loop);
      row.extra += r.extra;
      if (r.by === 'secretary') row.secretaryGrants++;
      row.noProgress = false;
      row.lastSignature = null;
    }
  }

  private check(r: BaseRecord): void {
    validateRecord(r);
    for (const v of Object.values(r)) if (isListRef(v) && !this.content.has(v.hash)) throw new FlowPortError('MISSING_CONTENT', `${r.kind}: list ${v.hash} is not stored`);
    if (r.kind === 'object.version' || r.kind === 'judgment' || r.kind === 'evidence') {
      const key = r.kind === 'object.version' ? r.object : r.kind === 'judgment' ? r.judgment : r.evidence;
      const same = this.base.find((c) => c.record.kind === r.kind && (c.record.kind === 'object.version' ? c.record.object : c.record.kind === 'judgment' ? c.record.judgment : c.record.kind === 'evidence' ? c.record.evidence : null) === key);
      if (same !== undefined && canonicalJson(same.record) !== canonicalJson(r)) throw new FlowPortError('FACT_CONFLICT', `${r.kind} ${key} exists with another content`);
    }
  }

  async events<B = unknown>(q: { readonly mission: MissionId; readonly line?: string; readonly event?: string }): Promise<readonly FlowEvent<B>[]> {
    return this.flow
      .filter((c) => c.record.mission === q.mission && (q.line === undefined || c.record.line === q.line) && (q.event === undefined || c.record.event === q.event))
      .map((c) => ({ revision: c.revision, mission: c.record.mission, line: c.record.line, event: c.record.event, key: c.record.key, body: JSON.parse(this.content.get(c.record.body)) as B }));
  }

  async records<K extends BaseRecordKind>(kinds: readonly K[], o: { readonly mission?: MissionId } = {}): Promise<ReadonlyArray<Committed<Extract<BaseRecord, { kind: K }>>>> {
    const set = new Set<string>(kinds);
    return this.base.filter((c) => set.has(c.record.kind) && (o.mission === undefined || (c.record as { mission?: unknown }).mission === o.mission)) as unknown as ReadonlyArray<Committed<Extract<BaseRecord, { kind: K }>>>;
  }

  async objectVersion(object: string): Promise<Extract<BaseRecord, { kind: 'object.version' }> | null> {
    for (let i = this.base.length - 1; i >= 0; i--) {
      const r = (this.base[i] as Committed<BaseRecord>).record;
      if (r.kind === 'object.version' && r.object === object) return r;
    }
    return null;
  }

  async judgment(judgment: string): Promise<Extract<BaseRecord, { kind: 'judgment' }> | null> {
    for (let i = this.base.length - 1; i >= 0; i--) {
      const r = (this.base[i] as Committed<BaseRecord>).record;
      if (r.kind === 'judgment' && r.judgment === judgment) return r;
    }
    return null;
  }

  async commitProofOp(req: { readonly op: string; readonly opId: string; readonly asOf: number; readonly events?: readonly FlowEventInput[] }): Promise<void> {
    if (this.ops.has(req.op)) return;
    const pending = this.base.some((c) => c.record.kind === 'op.pending' && c.record.op === req.opId);
    if (!pending) throw new FlowPortError('NOT_PENDING', `operation ${req.opId} was never registered as pending`);
    if (this.base.some((c) => c.record.kind === 'op.executed' && c.record.op === req.opId)) throw new FlowPortError('FACT_CONFLICT', `operation ${req.opId} was already executed`);
    if (req.asOf > this.rev) throw new FlowPortError('NOT_READY', `as-of revision ${req.asOf} is past the ledger head ${this.rev}`);
    // the execution and its events in one transaction
    if ((req.events ?? []).length > 0) await this.append(`${req.op}:events`, { events: req.events ?? [] });
    this.commit([{ kind: 'op.executed', op: req.opId as never, asOf: req.asOf as Revision }]);
    this.ops.set(req.op, 'proof-op');
  }

  private row(lineage: string, loop: LoopKind): LoopRow {
    const k = `${lineage}\u0000${loop}`;
    let r = this.loops.get(k);
    if (r === undefined) {
      r = { attempts: 0, extra: 0, secretaryGrants: 0, lastSignature: null, noProgress: false };
      this.loops.set(k, r);
    }
    return r;
  }

  private statusOf(lineage: string, loop: LoopKind): LoopStatus {
    const r = this.row(lineage, loop);
    const allowed = LOOP_CAPS[loop] + r.extra;
    const used = [...this.loops.entries()].some(([k, v]) => k.startsWith(`${lineage}\u0000`) && v.secretaryGrants > 0);
    const reason = r.attempts >= allowed ? 'cap' : r.noProgress ? 'no-progress' : null;
    return { lineage, loop, attempts: r.attempts, allowed, exhausted: reason !== null, reason, secretaryGrantUsed: used };
  }

  async loop(lineage: string, loop: LoopKind): Promise<LoopStatus> {
    return this.statusOf(lineage, loop);
  }

  /** One attempt, through the same op idempotency as every append (same op, other payload: OP_CONFLICT). */
  async loopAttempt(req: { readonly op: string; readonly lineage: string; readonly loop: LoopKind; readonly signature: string; readonly failureClass?: string | null }): Promise<LoopStatus> {
    await this.append(req.op, { records: [{ kind: 'loop.attempt', lineage: req.lineage, loop: req.loop, failureClass: req.failureClass ?? null, signature: req.signature }] });
    return this.statusOf(req.lineage, req.loop);
  }

  /** The ledger side of a grant (6.5): the Secretary once per lineage, at most 2 extra. */
  async grantLoop(req: { readonly lineage: string; readonly loop: LoopKind; readonly by: 'secretary' | 'user'; readonly extra: number; readonly op: string; readonly reason?: string }): Promise<{ granted: boolean; why?: string }> {
    if (this.ops.has(req.op)) return { granted: true };
    if (req.by === 'secretary') {
      if (req.extra < 1 || req.extra > 2) return { granted: false, why: 'too-many' };
      if (this.statusOf(req.lineage, req.loop).secretaryGrantUsed) return { granted: false, why: 'secretary-already-granted' };
    }
    const reason = this.content.put(canonicalJson({ format: 'mp4.loop-grant-reason.v2', reason: req.reason ?? '', by: req.by }));
    await this.append(req.op, { records: [{ kind: 'loop.grant', lineage: req.lineage, loop: req.loop, by: req.by, extra: req.extra, reason }] });
    return { granted: true };
  }

  /** Tests: make the next notice matching this predicate fail (the alert channel is down). */
  failNotifyNext: ((n: FlowNotice) => boolean) | null = null;

  async notify(n: FlowNotice): Promise<void> {
    if (this.failNotifyNext?.(n)) {
      this.failNotifyNext = null;
      throw new FlowPortError('UNAVAILABLE', `injected failure of notice ${n.category}:${n.key}`);
    }
    if (this.notices.some((x) => x.category === n.category && x.key === n.key)) return;
    this.notices.push(n);
  }

  async missions(): Promise<readonly MissionId[]> {
    return [...new Set(this.flow.map((c) => c.record.mission))];
  }

  /** Resolve a base record's lists (for the fake evaluator). */
  resolve(r: BaseRecord): ResolvedRecord {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(r)) out[k] = isListRef(v) ? this.content.getList(v) : v;
    return out as unknown as ResolvedRecord;
  }
}

// ---------------------------------------------------------------- scheduler

interface FakeTask {
  spec: FlowTask;
  state: FlowTaskState;
  note: string | null;
  disposition: FlowTaskStatus['disposition'];
  readonly launches: LaunchId[];
  handBack: AcceptedHandBack | null;
}

/** How the test ends a running task. */
export type FakeOutcome =
  /** The seat handed back `result`; checked by the kind's program rules, then accepted. */
  | { readonly handBack: unknown; readonly materialsRead?: ReadonlySet<string>; readonly export?: string; readonly exportHash?: ContentHash }
  /** The seat asked for async evidence (6.2): the task waits, holding nothing. */
  | { readonly evidence: unknown; readonly sessionId?: string }
  /** The attempt ended without an acceptable hand-back: the task needs disposition (Secretary). */
  | { readonly fail: 'seat-failure' | 'quarantine' | 'resource-exceeded' | 'stop' }
  /** The environment-retry loop is exhausted (6.5): the task is exhausted. */
  | { readonly exhaust: string };

export class FakeFlowScheduler implements FlowSchedulerPort {
  readonly tasks = new Map<string, FakeTask>();
  private readonly ledger: FakeFlowLedger;
  private readonly products = new Map<string, ProductVersion>();
  private readonly verified = new Map<string, readonly VerificationRun[]>();
  /** Tests: whether a verification command passes (default: all pass). */
  verifyPass: (req: VerifyRequest, command: string) => boolean = () => true;
  /** Tests: the concrete paths a product version covers (default: one file per write-scope pattern). */
  productPaths: (req: ProductRequest) => readonly string[] = (req) =>
    req.writeScope.map((p) => (p === '**' ? 'index.ts' : p.endsWith('/**') ? `${p.slice(0, -3)}/index.ts` : p));
  /** Tests: verification is asynchronous for this many calls per object before it completes. */
  verifyDelay = 0;
  private readonly verifyCalls = new Map<string, number>();
  private envRegistered = false;

  constructor(ledger: FakeFlowLedger) {
    this.ledger = ledger;
  }

  async submit(task: FlowTask): Promise<void> {
    if (this.tasks.has(task.task)) return;
    seatCardEntry(task.card.seat).schema.parse(task.card); // a malformed card is a flow defect
    this.tasks.set(task.task, { spec: task, state: 'queued', note: null, disposition: null, launches: [], handBack: null });
  }

  async status(task: string): Promise<FlowTaskStatus | null> {
    const t = this.tasks.get(task);
    if (t === undefined) return null;
    return { task, state: t.state, note: t.note, disposition: t.disposition, launches: [...t.launches], handBack: t.handBack };
  }

  async cancel(task: string): Promise<boolean> {
    const t = this.tasks.get(task);
    if (t === undefined || t.state === 'running') return false;
    t.state = 'abandoned';
    t.note = 'cancelled';
    return true;
  }

  async supersede(task: string, by: FlowTask): Promise<void> {
    const t = this.tasks.get(task);
    if (t !== undefined && t.state !== 'running' && t.state !== 'abandoned') {
      t.state = 'abandoned';
      t.note = `superseded by ${by.task}`;
    }
    await this.submit(by);
  }

  async restart(task: string, signature: string): Promise<LoopStatus | null> {
    const t = this.tasks.get(task);
    if (t === undefined || t.state !== 'needs-disposition' || t.disposition === 'stop' || t.disposition === 'resource-exceeded') return null;
    const pre = await this.ledger.loop(t.spec.lineage, 'quarantine-restart');
    if (pre.exhausted) {
      t.state = 'exhausted';
      t.note = 'quarantine restarts exhausted';
      return pre;
    }
    const v = await this.ledger.loopAttempt({ op: `restart:${task}:${t.launches.length}`, lineage: t.spec.lineage, loop: 'quarantine-restart', signature });
    t.state = 'queued';
    t.disposition = null;
    t.note = `restarted (${v.attempts}/${v.allowed})`;
    return v;
  }

  async grant(req: { readonly op: string; readonly lineage: string; readonly loop: LoopKind; readonly by: 'secretary' | 'user'; readonly extra: number; readonly reason: string }): Promise<{ readonly granted: boolean; readonly why?: string }> {
    const g = await this.ledger.grantLoop(req);
    if (!g.granted) return g;
    for (const t of this.tasks.values()) {
      if (t.spec.lineage === req.lineage && t.state === 'exhausted' && !(await this.ledger.loop(req.lineage, req.loop)).exhausted) {
        t.state = 'queued';
        t.note = `granted ${req.extra} more by ${req.by}`;
      }
    }
    return { granted: true };
  }

  /** Tests: the program actions to use instead of the fake's own (e.g. the real src/flow/actions). */
  actions: { snapshot?: FlowSchedulerPort['snapshot']; product?: FlowSchedulerPort['product']; verify?: FlowSchedulerPort['verify'] } = {};

  async snapshot(req: Parameters<FlowSchedulerPort['snapshot']>[0]): ReturnType<FlowSchedulerPort['snapshot']> {
    if (this.actions.snapshot !== undefined) return this.actions.snapshot(req);
    const writable = req.writable?.map((p) => (p === '**' ? '.' : p.endsWith('/**') ? p.slice(0, -3) : p));
    return { path: `/fake/snapshots/${req.mission}/${req.purpose}`, commit: req.commit ?? 'b'.repeat(40), ...(writable !== undefined ? { writable } : {}) };
  }

  /** Tests: symbols the fake snapshot has, as "file#symbol" (default: every symbol exists). */
  symbols: ReadonlySet<string> | null = null;

  async findSymbol(req: { readonly snapshot: string; readonly file: string; readonly symbol: string }): Promise<boolean> {
    return this.symbols === null || this.symbols.has(`${req.file}#${req.symbol}`);
  }

  async history(): Promise<{ readonly gitLog: string; readonly runs: ReadonlyArray<{ readonly task: string; readonly seat: string; readonly durationMs: number; readonly costMicros: number }> }> {
    return { gitLog: 'b000000 initial commit', runs: [] };
  }

  async product(req: ProductRequest): Promise<ProductVersion> {
    if (this.actions.product !== undefined) return this.actions.product(req);
    const known = this.products.get(req.launch);
    if (known !== undefined) return known;
    const object = `product.${req.launch}`;
    const paths = [...this.productPaths(req)];
    const content = this.ledger.content.put(canonicalJson({ format: 'fake.write-scope', export: req.export, paths }));
    this.ledger.commit([
      {
        kind: 'object.version',
        object: object as never,
        objectKind: 'product',
        mission: req.mission,
        module: req.module as never,
        content,
        prerequisites: this.ledger.content.putList(req.prerequisites),
        scope: { paths, taskType: req.taskType },
        reviews: req.reviews,
        ...(req.predecessor !== null ? { predecessor: req.predecessor as never } : {}),
      },
    ]);
    const p: ProductVersion = { object, commit: sha256(object).slice(0, 40), snapshot: `/fake/candidates/${object}`, changedPaths: paths };
    this.products.set(req.launch, p);
    return p;
  }

  async verify(req: VerifyRequest): Promise<readonly VerificationRun[] | 'pending'> {
    if (this.actions.verify !== undefined) return this.actions.verify(req);
    const known = this.verified.get(req.object);
    if (known !== undefined) return known;
    const n = (this.verifyCalls.get(req.object) ?? 0) + 1;
    this.verifyCalls.set(req.object, n);
    if (n <= this.verifyDelay) return 'pending';
    if (!this.envRegistered) {
      this.ledger.commit([{ kind: 'env.snapshot', line: 'env.fake' as never, snapshot: 'snap.1' as never }]);
      this.envRegistered = true;
    }
    const runs = req.commands.map((c) => {
      const passed = this.verifyPass(req, c.id);
      return { evidence: `ev.${req.object}.${idPart(c.id)}`, command: c.command, summary: passed ? 'exit 0' : 'exit 1', passed };
    });
    this.ledger.commit(
      runs.map((r) => ({ kind: 'evidence' as const, evidence: r.evidence as never, envLine: 'env.fake' as never, envSnapshot: 'snap.1' as never, runClass: 'closed' as const, fields: { exit: r.passed ? '0' : '1' } })),
    );
    this.verified.set(req.object, runs);
    return runs;
  }

  // ------------------------------------------------------------ test driver

  /** Queued tasks (optionally of one card kind), in submission order. */
  queued(kind?: string): FlowTask[] {
    return [...this.tasks.values()].filter((t) => t.state === 'queued' && (kind === undefined || t.spec.card.seat === kind)).map((t) => t.spec);
  }

  /** The card of a task. */
  card<C>(task: string): C {
    const t = this.tasks.get(task);
    if (t === undefined) throw new Error(`no task ${task}`);
    return t.spec.card as unknown as C;
  }

  /**
   * End a task's next attempt as the seat host would. Returns the problems when the hand-back
   * is refused by the program's rules (the task stays queued: the seat would be told to fix it).
   */
  run(task: string, outcome: FakeOutcome): string[] {
    const t = this.tasks.get(task);
    if (t === undefined) throw new Error(`no task ${task}`);
    if (t.state !== 'queued') throw new Error(`task ${task} is ${t.state}, not queued`);
    const launch = `${task}.L${t.launches.length + 1}` as LaunchId;
    const card = t.spec.card;
    if ('handBack' in outcome) {
      const read = outcome.materialsRead ?? allPages(card);
      const problems = handBackProblems(card, outcome.handBack, { materialsRead: read, snapshot: { lines: () => 10_000 } });
      if (problems.length > 0) return problems;
      t.launches.push(launch);
      const doc = JSON.stringify({ format: 'mp4.seat-result.v1', launch, seat: card.seat, result: outcome.handBack });
      const resultHash = this.ledger.content.put(doc);
      const records: BaseRecord[] =
        card.seat === 'reviewer'
          ? reviewerRecords(card as unknown as ReviewerCard, outcome.handBack as ReviewerResult, this.ledger.content, launch)
          : handBackRecords(card, outcome.handBack, { launch, content: this.ledger.content });
      const exportHash = card.seat === 'constructor' ? (outcome.exportHash ?? this.ledger.content.put(outcome.export ?? `export of ${launch}`)) : null;
      const seat: SeatResultRecord = { kind: 'seat.result', launch, seat: card.seat, status: 'handed-back', result: resultHash, export: exportHash, transcript: null, recoveryState: null, evidenceRequest: null };
      this.ledger.commit([...records, seat]);
      t.state = 'done';
      t.note = 'accepted';
      t.handBack = { launch, status: 'handed-back', result: outcome.handBack, resultHash, export: exportHash, evidenceRequest: null, recoveryState: null, sessionId: null, records };
      return [];
    }
    t.launches.push(launch);
    if ('evidence' in outcome) {
      const req = this.ledger.content.put(canonicalJson({ format: 'mp4.evidence-request.v1', launch, ...(outcome.evidence as object) }));
      const state = this.ledger.content.put(`recovery state of ${launch}`);
      this.ledger.commit([{ kind: 'seat.result', launch, seat: card.seat, status: 'needs-evidence', result: null, export: null, transcript: null, recoveryState: state, evidenceRequest: req }]);
      t.state = 'waiting-evidence';
      t.note = 'needs evidence';
      t.handBack = { launch, status: 'needs-evidence', result: null, resultHash: null, export: null, evidenceRequest: req, recoveryState: state, sessionId: outcome.sessionId ?? `session.${launch}`, records: [] };
      return [];
    }
    if ('fail' in outcome) {
      t.state = 'needs-disposition';
      t.disposition = outcome.fail === 'quarantine' ? 'quarantine' : outcome.fail;
      t.note = `seat ${outcome.fail}`;
      return [];
    }
    if (!('exhaust' in outcome)) throw new Error(`unknown outcome for ${task}: ${JSON.stringify(outcome).slice(0, 200)}`);
    t.state = 'exhausted';
    t.note = `environment retries exhausted: ${outcome.exhaust}`;
    return [];
  }
}

function allPages(card: { readonly seat: string } & Readonly<Record<string, unknown>>): Set<string> {
  const out = new Set<string>();
  const materials = (card as { materials?: readonly MaterialRef[] }).materials ?? [];
  for (const m of materials) for (let p = 1; p <= m.pages; p++) out.add(materialPageKey(m.id, p));
  return out;
}

/** The records the host makes from a Reviewer's hand-back (src/seat/host.ts). */
function reviewerRecords(card: ReviewerCard, r: ReviewerResult, content: FakeContent, launch: LaunchId): BaseRecord[] {
  const store = content as unknown as ContentStore;
  return [judgmentRecord(card, r, content.putList(citedEvidence(card, r))), ...findingRecords(card, r, store, launch)];
}

// ---------------------------------------------------------------- evaluator

export class FakeFlowEvaluator implements FlowEvaluatorPort {
  private readonly ledger: FakeFlowLedger;
  private readonly inc = new IncrementalDerivation();
  private applied = 0;

  constructor(ledger: FakeFlowLedger) {
    this.ledger = ledger;
  }

  /** Apply every evaluator input committed since the last call, at the ledger's head. */
  private sync(): number {
    const head = this.ledger.head;
    if (head === this.applied) return head;
    const batch: ResolvedCommitted[] = this.ledger.base
      .filter((c) => c.revision > this.applied && EVALUATOR_INPUT_KINDS.has(c.record.kind))
      .map((c) => ({ revision: c.revision, record: this.ledger.resolve(c.record) }));
    this.inc.apply(batch, head as Revision);
    this.applied = head;
    return head;
  }

  async labels(ids: readonly string[]): Promise<{ readonly revision: number; readonly labels: Readonly<Record<string, import('../evaluator/semantics.ts').Label | null>> }> {
    const revision = this.sync();
    const s = this.inc.state();
    return { revision, labels: Object.fromEntries(ids.map((i) => [i, s.targets.get(i)?.label ?? null])) };
  }

  async deciding(ids: readonly string[]): Promise<{ readonly revision: number; readonly views: Readonly<Record<string, import('../evaluator/semantics.ts').DecidingView | null>> }> {
    const revision = this.sync();
    return { revision, views: Object.fromEntries(this.inc.deciding(ids)) };
  }

  async judgments(ids: readonly string[]): Promise<{ readonly revision: number; readonly current: Readonly<Record<string, boolean | null>> }> {
    const revision = this.sync();
    const s = this.inc.state();
    return { revision, current: Object.fromEntries(ids.map((i) => [i, s.judgmentCurrent.get(i as never) ?? null])) };
  }

  async ops(ids: readonly string[]): Promise<{ readonly revision: number; readonly states: Readonly<Record<string, { readonly allProven: boolean; readonly executedAsOf: number | null } | null>> }> {
    const revision = this.sync();
    const s = this.inc.state();
    return {
      revision,
      states: Object.fromEntries(
        ids.map((i) => {
          const o = s.ops.get(i as never);
          return [i, o === undefined ? null : { allProven: o.allProven, executedAsOf: o.executedAsOf }];
        }),
      ),
    };
  }
}

/** The three fakes wired together. */
export function fakePorts(): { ledger: FakeFlowLedger; scheduler: FakeFlowScheduler; evaluator: FakeFlowEvaluator } {
  const ledger = new FakeFlowLedger();
  return { ledger, scheduler: new FakeFlowScheduler(ledger), evaluator: new FakeFlowEvaluator(ledger) };
}
