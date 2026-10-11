// The flows' ports on a real project memory, for the flow tests (design 4.1 §14 "Process": the
// flow suites run on the memory, not on in-memory fakes). The ledger, the dispatch table and the
// labels are the real ones (src/process/ports.ts on src/memory and src/evaluator); only what needs
// git is replaced: the program actions (snapshot, product, verification) and the Constructor's
// worktree record what the git-backed ones would, without a repository. A test runs a queued task
// as a seat would: `mp pm dispatch`, the material pages read, `mp seat <id> handback` (or an
// evidence request, or the PM's release of an interrupted dispatch).

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonicalJson, sha256 } from '../src/common/hash.ts';
import { idPart, type ContentHash, type EvidenceId, type MissionId } from '../src/common/ids.ts';
import type { BaseRecord, LoopKind, ObjectVersionRecord } from '../src/common/records.ts';
import { validateRecord } from '../src/common/validate.ts';
import '../src/evaluator/index.ts';
import { ENV_LINE, forgetObservedEnvironment, runClassOf, type EnvironmentParts } from '../src/evaluator/index.ts';
import type { FlowNotice, FlowTask, ProductRequest, ProductVersion, VerificationRun, VerifyRequest } from '../src/flow/ports.ts';
import type { ScriptedOutcome, ScriptedScheduler } from '../src/flow/scripted.ts';
import { appendRecords, initMemory, LedgerError, listDispatches, openMemory, recordWords, type Memory } from '../src/memory/index.ts';
import {
  DISPATCH_LINE,
  MemoryFlowEvaluator,
  MemoryFlowLedger,
  MemoryFlowScheduler,
  pmDispatch,
  pmRelease,
  processContext,
  productObjectId,
  recordEvidenceRequest,
  recordSeatHandBack,
  seatRead,
  taskStatus,
  type GitActions,
  type HandBackAnswer,
  type ProcessContext,
  type WorkspaceOps,
} from '../src/process/index.ts';
import type { MaterialRef } from '../src/seat/cards/common.ts';
import type { SnapshotFiles } from '../src/seat/results.ts';
import { dispatchView } from '../src/process/seat.ts';

export const FAKE_BASE = 'b'.repeat(40);
const ENV: EnvironmentParts = { os: 'flowtest', osVersion: '1', arch: 'x64', versions: {} };

const fakeCommit = (...parts: string[]): string => sha256(parts.join('\n')).slice(0, 40);

/** What the fake program actions do; tests change these knobs. */
export interface FakeKnobs {
  /** Whether a verification command passes (default: all pass). */
  verifyPass: (req: VerifyRequest, command: string) => boolean;
  /** The paths a product version covers (default: one file per write-scope pattern). */
  productPaths: (req: ProductRequest) => readonly string[];
  /** Verification answers "pending" this many calls per object before it runs. */
  verifyDelay: number;
  /** Symbols the snapshot has, as "file#symbol" (null: every symbol exists). */
  symbols: ReadonlySet<string> | null;
  /** Program actions instead of the fakes (e.g. a test's own snapshot). */
  actions: Partial<Pick<GitActions, 'snapshot' | 'product' | 'verify'>>;
  /** The candidate collection at a Constructor's hand-back (default: a candidate commit). */
  collect: WorkspaceOps['collect'] | null;
  /** The files of a snapshot commit that file: pointers are checked against (default null: no repository here, not checked). */
  files: ((commit: string) => SnapshotFiles | null) | null;
}

function fakeActions(ctx: ProcessContext, k: FakeKnobs): GitActions {
  const verified = new Map<string, readonly VerificationRun[]>();
  const calls = new Map<string, number>();
  return {
    async snapshot(req) {
      if (k.actions.snapshot !== undefined) return k.actions.snapshot(req);
      const products = [...new Set(req.products ?? [])].sort();
      const commit = products.length === 0 ? (req.commit ?? FAKE_BASE) : fakeCommit(req.commit ?? FAKE_BASE, ...products);
      return { path: commit, commit, ...(req.writable !== undefined ? { writable: [...req.writable] } : {}) };
    },
    async product(req: ProductRequest): Promise<ProductVersion> {
      if (k.actions.product !== undefined) return k.actions.product(req);
      const object = productObjectId(req.task);
      const paths = [...k.productPaths(req)];
      const pv: ProductVersion = { object, commit: req.candidate, snapshot: req.candidate, changedPaths: paths };
      const exists = ctx.memory.read((db) => Boolean(db.stmt("SELECT 1 FROM facts WHERE kind = 'object.version' AND id = ?").get(object)));
      if (exists) return pv;
      const rec: ObjectVersionRecord = {
        kind: 'object.version',
        object: object as never,
        objectKind: 'product',
        mission: req.mission,
        module: req.module as never,
        content: ctx.memory.data.put(canonicalJson({ format: 'fake.write-scope', candidate: req.candidate, paths })) as ContentHash,
        prerequisites: ctx.memory.data.putList(req.prerequisites),
        scope: { paths, taskType: req.taskType },
        reviews: [...req.reviews],
        ...(req.predecessor !== null ? { predecessor: req.predecessor as never } : {}),
      };
      validateRecord(rec);
      ctx.memory.write({ op: `flow:product-version:${req.mission}:${object}`, payload: { object, candidate: req.candidate } }, (tx) => appendRecords(tx, [rec]));
      return pv;
    },
    async verify(req: VerifyRequest) {
      if (k.actions.verify !== undefined) return k.actions.verify(req);
      const known = verified.get(req.object);
      if (known !== undefined) return known;
      const n = (calls.get(req.object) ?? 0) + 1;
      calls.set(req.object, n);
      if (n <= k.verifyDelay) return 'pending';
      const env = ctx.environment();
      const runs = req.commands.map((c) => {
        const passed = k.verifyPass(req, c.id);
        return { evidence: `ev.${req.object}.${idPart(c.id)}`, command: c.command, summary: passed ? 'completed; exit 0' : 'completed; exit 1', passed };
      });
      const records: BaseRecord[] = runs.map((r, i) => ({
        kind: 'evidence' as const,
        evidence: r.evidence as EvidenceId,
        envLine: ENV_LINE,
        envSnapshot: env.identity,
        runClass: runClassOf({ by: 'mp', checkout: 'clean', declared: true, network: false, sampled: (req.commands[i] as { sampled?: boolean }).sampled === true }),
        fields: { exit: r.passed ? '0' : '1', status: 'completed', candidate: req.snapshot, command: r.command },
      }));
      if (records.length > 0) ctx.memory.write({ op: `fake-verify:${req.object}`, payload: { object: req.object } }, (tx) => appendRecords(tx, records));
      verified.set(req.object, runs);
      return runs;
    },
    async findSymbol(req) {
      return k.symbols === null || k.symbols.has(`${req.file}#${req.symbol}`);
    },
    async history() {
      return { gitLog: 'b000000 initial commit', runs: [] };
    },
  };
}

function fakeWorkspaces(k: FakeKnobs): WorkspaceOps {
  return {
    ensure: (dispatch) => ({ path: `worktrees/${dispatch}`, created: true }),
    remove: () => ({ removed: true }),
    release: (_d, how) => ({ removed: how === 'ended', kept: how === 'abandoned' }),
    async collect(req) {
      if (k.collect !== null) return k.collect(req);
      const commit = fakeCommit('candidate', req.dispatch, req.base);
      return { kind: 'candidate', base: req.base as never, commit: commit as never, tree: commit as never, empty: false, added: [], modified: [], deleted: [], modeChanged: [], ignored: { paths: [], total: 0 } };
    },
  };
}

// ---------------------------------------------------------------- the ports, with the tests' handles

export class HarnessLedger extends MemoryFlowLedger {
  private readonly memory_: Memory;
  /** Tests: make the next append with an op matching this predicate fail (a lost write). */
  failNext: ((op: string) => boolean) | null = null;
  /** Tests: make the next notice matching this predicate fail. */
  failNotifyNext: ((n: FlowNotice) => boolean) | null = null;
  /** The ops of appends that wrote something, in order. */
  readonly appended: string[] = [];

  constructor(ctx: ProcessContext) {
    super(ctx);
    this.memory_ = ctx.memory;
  }

  override async append(op: string, entries: Parameters<MemoryFlowLedger['append']>[1]): Promise<void> {
    if (this.failNext?.(op)) {
      this.failNext = null;
      throw Object.assign(new Error(`injected failure of ${op}`), { code: 'UNAVAILABLE' });
    }
    const before = Number(this.memory_.head());
    await super.append(op, entries);
    if (Number(this.memory_.head()) > before) this.appended.push(op);
  }

  override async notify(n: FlowNotice): Promise<void> {
    if (this.failNotifyNext?.(n)) {
      this.failNotifyNext = null;
      throw Object.assign(new Error(`injected failure of notice ${n.category}:${n.key}`), { code: 'UNAVAILABLE' });
    }
    await super.notify(n);
  }

  get head(): number {
    return Number(this.memory_.head());
  }

  /** The notices raised so far (the flows' alerts), oldest first. */
  get notices(): FlowNotice[] {
    const data = this.memory_.data;
    return this.memory_.read((db) =>
      (db.stmt("SELECT record FROM log WHERE kind = 'alert' ORDER BY rev").all() as Array<{ record: string }>).flatMap((r) => {
        const rec = JSON.parse(r.record) as { alert: string; body: string };
        if (!rec.alert.startsWith('flow:')) return [];
        const b = JSON.parse(data.text(rec.body)) as FlowNotice;
        return [{ category: b.category, wi: b.wi, key: b.key, mission: b.mission, trigger: b.trigger, defaultAction: b.defaultAction, detail: b.detail, ...(b.askUser === true ? { askUser: true } : {}) }];
      }),
    );
  }

  /** Commit base records directly (a setup). */
  commit(records: readonly BaseRecord[]): void {
    this.memory_.write({}, (tx) => appendRecords(tx, records));
  }

  /** The ledger side of a grant (6.5): the Secretary once per lineage, at most 2 extra. */
  async grantLoop(req: { readonly lineage: string; readonly loop: LoopKind; readonly by: 'secretary' | 'user'; readonly extra: number; readonly op: string; readonly reason?: string }): Promise<{ granted: boolean; why?: string }> {
    if (req.by === 'secretary' && (req.extra < 1 || req.extra > 2)) return { granted: false, why: 'too-many' };
    try {
      this.memory_.write({ op: req.op, payload: { lineage: req.lineage, loop: req.loop, by: req.by, extra: req.extra } }, (tx) => {
        const reason = tx.data.put(canonicalJson({ format: 'mp4.loop-grant-reason.v2', reason: req.reason ?? '', by: req.by })) as ContentHash;
        appendRecords(tx, [{ kind: 'loop.grant', lineage: req.lineage, loop: req.loop, by: req.by, extra: req.extra, reason }]);
      });
    } catch (e) {
      if (e instanceof LedgerError && e.code === 'GRANT_LIMIT') return { granted: false, why: 'secretary-already-granted' };
      throw e;
    }
    return { granted: true };
  }
}

export interface HarnessTask {
  readonly spec: FlowTask;
  readonly state: string;
  readonly note: string | null;
  readonly dispatches: readonly string[];
  readonly handBack: ReturnType<typeof taskStatus> extends infer S ? (S extends { handBack: infer H } ? H : null) : null;
}

export class HarnessScheduler extends MemoryFlowScheduler implements ScriptedScheduler {
  private readonly hctx: ProcessContext;
  readonly knobs: FakeKnobs;
  /** The last hand-back answer of each task (tests read refusals and outcomes). */
  readonly answers = new Map<string, HandBackAnswer>();

  constructor(ctx: ProcessContext, knobs: FakeKnobs) {
    super(ctx);
    this.hctx = ctx;
    this.knobs = knobs;
  }

  set verifyPass(f: FakeKnobs['verifyPass']) {
    this.knobs.verifyPass = f;
  }
  set verifyDelay(n: number) {
    this.knobs.verifyDelay = n;
  }
  set productPaths(f: FakeKnobs['productPaths']) {
    this.knobs.productPaths = f;
  }
  set symbols(s: ReadonlySet<string> | null) {
    this.knobs.symbols = s;
  }
  get actions(): FakeKnobs['actions'] {
    return this.knobs.actions;
  }
  set actions(a: FakeKnobs['actions']) {
    this.knobs.actions = a;
  }

  /** Every task, in the order it was first queued. */
  get tasks(): Map<string, HarnessTask> {
    const data = this.hctx.memory.data;
    return this.hctx.memory.read((db) => {
      const out = new Map<string, HarnessTask>();
      for (const r of db.stmt('SELECT task, card FROM tasks ORDER BY rowid').all() as Array<{ task: string; card: string }>) {
        const st = taskStatus(db, data, r.task)!;
        out.set(r.task, { spec: JSON.parse(data.text(r.card)) as FlowTask, state: st.state, note: st.note, dispatches: st.dispatches, handBack: st.handBack as never });
      }
      return out;
    });
  }

  /** Queued tasks (optionally of one card kind), in the order they were first queued; a task whose hand-back was refused stays runnable. */
  queued(kind?: string): FlowTask[] {
    return [...this.tasks.values()].filter((t) => (t.state === 'queued' || this.refusedInFlight(t)) && (kind === undefined || t.spec.card.seat === kind)).map((t) => t.spec);
  }

  private refusedInFlight(t: HarnessTask): boolean {
    const a = this.answers.get(t.spec.task);
    return t.state === 'running' && a?.kind === 'refused';
  }

  card<C>(task: string): C {
    const t = this.tasks.get(task);
    if (t === undefined) throw new Error(`no task ${task}`);
    return t.spec.card as unknown as C;
  }

  /** The task's dispatch in flight, if any. */
  private inFlight(task: string): string | null {
    return this.hctx.memory.read((db) => listDispatches(db, { task, state: 'in-flight', limit: 10 })[0]?.dispatch ?? null);
  }

  /** A run the dispatch had `mp` rerun (a sampling run; no repository needed here): its run id. */
  rerun(dispatch: string, command: string, completed = true): string {
    const v = dispatchView(this.hctx, dispatch);
    const env = this.hctx.environment();
    const run = `rerun-${sha256(`${dispatch}:${command}:${Math.random()}`).slice(0, 12)}`;
    this.hctx.memory.write({}, (tx) =>
      appendRecords(tx, [
        { kind: 'evidence', evidence: run as never, envLine: ENV_LINE, envSnapshot: env.identity, runClass: 'sampling', fields: { status: completed ? 'completed' : 'failed', exit: completed ? '0' : '1', command, dispatch } },
        { kind: 'flow.event', mission: v.info.mission, line: DISPATCH_LINE(dispatch), event: 'run', key: run, body: tx.data.put(canonicalJson({ run, command, completed, exit: completed ? '0' : '1', envLine: ENV_LINE, envSnapshot: env.identity })) as ContentHash },
      ]),
    );
    return run;
  }

  /** Claim the task's dispatch (or take the one still in flight after a refused hand-back). */
  dispatchOf(task: string): string {
    return this.inFlight(task) ?? pmDispatch(this.hctx, task, { filledBy: 'test-harness/scripted' }).dispatch;
  }

  /**
   * End a task's dispatch as its seat (or the PM) would. Returns the problems when the hand-back
   * is refused by the program's rules (the dispatch stays in flight: the seat would fix it).
   */
  async run(task: string, outcome: ScriptedOutcome & { readonly before?: (dispatch: string) => void }): Promise<string[]> {
    const dispatch = this.dispatchOf(task);
    outcome.before?.(dispatch);
    if ('release' in outcome) {
      await pmRelease(this.hctx, dispatch, outcome.release);
      return [];
    }
    let a: HandBackAnswer;
    if ('evidence' in outcome) a = await recordEvidenceRequest(this.hctx, dispatch, { request: outcome.evidence, notes: outcome.notes ?? `notes of ${dispatch}`, advance: false });
    else {
      const v = dispatchView(this.hctx, dispatch);
      for (const m of ((v.card['materials'] as MaterialRef[] | undefined) ?? [])) {
        for (let p = 1; p <= m.pages; p++) if (outcome.materialsRead === undefined || outcome.materialsRead.has(`${m.id}#${p}`)) seatRead(this.hctx, dispatch, m.id, p);
      }
      a = await recordSeatHandBack(this.hctx, dispatch, { report: outcome.report ?? `report of ${dispatch}`, fields: outcome.handBack, advance: false });
    }
    this.answers.set(task, a);
    return a.kind === 'refused' ? [...a.problems] : [];
  }
}

export interface MemoryWorld {
  readonly ledger: HarnessLedger;
  readonly scheduler: HarnessScheduler;
  readonly evaluator: MemoryFlowEvaluator;
  readonly now: () => number;
  readonly ctx: ProcessContext;
  readonly memory: Memory;
  readonly dir: string;
}

const opened: Array<{ base: string; memory: Memory }> = [];
process.on('exit', () => {
  for (const o of opened) {
    try {
      o.memory.close();
      rmSync(o.base, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
});

/** The flows' ports on a fresh project memory (no repository): the 4.1 counterpart of the 4.0 fakePorts(). */
export function memoryPorts(o: { readonly now?: () => number } = {}): MemoryWorld {
  const base = mkdtempSync(join(tmpdir(), 'mp-flow-'));
  const dir = join(base, 'project');
  mkdirSync(dir, { recursive: true });
  initMemory(dir, { git: null });
  const memory = openMemory(dir, { git: null });
  opened.push({ base, memory });
  forgetObservedEnvironment(memory.projectDir);
  const knobs: FakeKnobs = {
    verifyPass: () => true,
    productPaths: (req) => req.writeScope.map((x) => (x === '**' ? 'index.ts' : x.endsWith('/**') ? `${x.slice(0, -3)}/index.ts` : x)),
    verifyDelay: 0,
    symbols: null,
    actions: {},
    collect: null,
    files: null,
  };
  const ctx = processContext(memory, { observe: () => ENV, actions: (c) => fakeActions(c, knobs), workspaces: () => fakeWorkspaces(knobs), snapshotFiles: (commit) => knobs.files?.(commit) ?? null, ...(o.now !== undefined ? { now: o.now } : {}) });
  const ledger = new HarnessLedger(ctx);
  const scheduler = new HarnessScheduler(ctx, knobs);
  const evaluator = new MemoryFlowEvaluator(ctx);
  return { ledger, scheduler, evaluator, now: ctx.now, ctx, memory, dir };
}

/** The user's words recorded as `mp pm say` does: their entry (W-<n>). */
export function say(w: { readonly memory: Memory }, text: string, message = `msg-${sha256(text).slice(0, 12)}`): string {
  return w.memory.write({ op: `say:${message}`, payload: { text } }, (tx) => recordWords(tx, { message, session: 'pm-session', at: 1_000 + Number(tx.head()), text })).words;
}

export type { MissionId };
