// The derived-state evaluator process logic (design 6.1 "派生状态").
//
// The state is maintained incrementally (incremental.ts, 5.4); fullCompute is its
// oracle. Any failed update drops the incremental state, and the next update
// rebuilds it from all records read so far and reconciles every operation, so a
// failure can never lose an episode change.
//
// One update:
//   1. read base records committed after the last published revision (a DB
//      snapshot) and resolve all of them; nothing is taken over unless all of
//      them resolve (a failed read never skips a fact);
//   2. apply them and compute the state at the last record read (R');
//   3. derive episode changes for executed proof operations (start / end);
//   4. publish R' through the ledger in one action: commit the episode batch
//      (if the change list is non-empty) and raise the publication floor. The
//      ledger refuses a stale evaluator epoch, so an old instance cannot publish
//      behind a newer one;
//   5. only then show R' to readers.
// Bookkeeping records (episode batches, notices, proofs) never change derived
// state, so an update that reads only them produces no batch and the system
// becomes quiescent (6.1).
//
// Reads answer at the published revision (core review r2 F5): between applying
// an update and its successful publication the incremental state is ahead of
// what readers may see, so the continuation check (which reads the incremental
// state) answers only while the two are the same revision; `settled()` lets a
// reader wait for the publication in flight.
//
// After each publication the evaluator raises one exception notice (WI-16) per
// dependency cycle that did not exist before (5.2 part 4). The notice's
// operation id is derived from the cycle's node set, so a restart that meets the
// same cycle again is answered with the original commit, not a second notice.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { canonicalJson, hashJson, sha256 } from '../common/hash.ts';
import { id, revision, type AlertId, type ContentHash, type EpisodeBatchId, type OpId, type Revision } from '../common/ids.ts';
import { EVALUATOR_INPUT_KINDS, type BaseRecord, type Committed, type EpisodeChange, type ListRef } from '../common/records.ts';
import type { ContentStore } from '../ledger/content.ts';
import type { ContinuationRequest, ContinuationResult, DecidingView, DerivedState, ResolvedCommitted, ResolvedRecord } from './semantics.ts';
import { IncrementalDerivation, type DependencyCycle } from './incremental.ts';
import { summarize, type CheckpointSummary } from './checkpoint.ts';

/** A system alert as the ledger takes it (3.9, 3.11: every exception notice names its WI). */
export interface AlertRequest {
  readonly op: string;
  readonly alert: AlertId;
  readonly category: string;
  readonly wi: string;
  readonly body: ContentHash;
}

/**
 * The ledger operations the evaluator needs; a LedgerService or an IPC client
 * adapter provides them. `beginEvaluator` takes no arguments here: the worker's
 * port supplies the scheduler generation and the process identity (6.1, 6.3).
 */
export interface EvaluatorLedgerPort {
  readRecordsAfter(after: Revision): Committed[];
  beginEvaluator(): Promise<{ epoch: number }>;
  publish(req: { epoch: number; revision: Revision; batch: { batch: EpisodeBatchId; changes: ListRef } | null }): Promise<{ floor: Revision }>;
  recordEvaluatorFailure(): Promise<number>;
  /**
   * No longer called: a successful publication resets the failure budget inside
   * `publish` itself (one ledger action, epoch-checked; core review r3 #7).
   */
  recordEvaluatorSuccess?(): Promise<void>;
  /** Exception notices (WI-16 dependency cycles). Without it the evaluator raises none. */
  raiseAlert?(req: AlertRequest): Promise<unknown>;
}

/** The WI-16 notice for one dependency cycle: deterministic, so a repeat is the same operation. */
export function cycleAlert(cycle: DependencyCycle, content: ContentStore): AlertRequest {
  const judgments = [...new Set(cycle.nodes.filter((n) => n.startsWith('j:')).map((n) => n.slice(2)))].sort();
  const targets = [...new Set(cycle.nodes.filter((n) => !n.startsWith('j:')).map((n) => n.slice(2)))].sort();
  const body = canonicalJson({
    category: 'dependency-cycle',
    wi: 'WI-16',
    key: `cycle:${cycle.id}`,
    source: 'evaluator',
    trigger:
      `a dependency cycle (5.2 part 4): judgments ${judgments.length > 0 ? judgments.join(', ') : '(none)'} and targets ${targets.join(', ')} ` +
      'depend on each other, so none of them can be proven',
    defaultAction: 'the cycle and everything relying on it stay not proven (least fixed point); every other piece of work continues',
    detail: { cycle: cycle.id, judgments, targets, nodes: cycle.nodes },
  });
  return { op: `alert:cycle:${cycle.id}`, alert: id<AlertId>(`cycle-${cycle.id}`), category: 'dependency-cycle', wi: 'WI-16', body: content.put(body) };
}

/** Version of the derivation rules. Checkpoints made under another version are discarded (6.1). */
export const RULES_VERSION = 'v35-2026-10-09';

/** Hash of the rule sources, so a code change also invalidates checkpoints. */
const RULES_CODE_HASH: string = (() => {
  const files = ['semantics.ts', 'incremental.ts', 'renewal.ts', 'evaluator.ts'];
  try {
    return sha256(files.map((f) => readFileSync(fileURLToPath(new URL(`./${f}`, import.meta.url)), 'utf8')).join('\u0000'));
  } catch {
    return 'unknown';
  }
})();

function isListRef(v: unknown): v is ListRef {
  return Boolean(v) && typeof v === 'object' && typeof (v as ListRef).hash === 'string' && typeof (v as ListRef).count === 'number';
}

/** Replace every ListRef in a record with the list it points to (the content store verifies hashes). */
export function resolveRecord(record: BaseRecord, content: ContentStore): ResolvedRecord {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(record)) {
    if (isListRef(v)) {
      const items = content.getList(v);
      if (items.length !== v.count) throw new Error(`list ${v.hash} has ${items.length} items, not ${v.count}`);
      out[k] = items;
    } else out[k] = v;
  }
  return out as unknown as ResolvedRecord;
}

export interface UpdateReport {
  readonly published: Revision;
  readonly changes: readonly EpisodeChange[];
  readonly batch: EpisodeBatchId | null;
}

interface Ingested {
  readonly chain: ContentHash;
  readonly lastRead: Revision;
  readonly inputs: ResolvedCommitted[];
  readonly episodes: EpisodeChange[];
}

export class Evaluator {
  private readonly ledger: EvaluatorLedgerPort;
  private readonly content: ContentStore;
  private readonly records: ResolvedCommitted[] = [];
  /** Raw committed records read so far (for checkpoints). */
  private readonly raw: Committed[] = [];
  /** Records read but not yet applied to `inc`. */
  private unapplied: ResolvedCommitted[] = [];
  /** The incremental state; null means "rebuild from `records` on the next update". */
  private inc: IncrementalDerivation | null = null;
  private lastRead: Revision = revision(0);
  private published: DerivedState | null = null;
  private epoch: number | null = null;
  private running: Promise<unknown> = Promise.resolve();
  /** Executed ops whose "all proven" episode is currently open (a start committed, no end yet). */
  private readonly openEpisodes = new Set<OpId>();
  /** Running hash over the records read so far; binds checkpoints to the record set. */
  private chain: ContentHash = sha256('');
  /** Set while an update has applied a revision that is not published yet; resolves when it settles. */
  private inFlight: { readonly done: Promise<void>; readonly settle: () => void } | null = null;
  /** Cycles already noticed by this instance (the ledger dedupes across instances by operation id). */
  private readonly noticedCycles = new Set<string>();
  /** WI-16 notices not yet accepted by the ledger; retried after every update. */
  private pendingAlerts: AlertRequest[] = [];
  /** Fault injection for tests. */
  injectComputeFault: (() => boolean) | null = null;

  constructor(ledger: EvaluatorLedgerPort, content: ContentStore) {
    this.ledger = ledger;
    this.content = content;
  }

  /** The published state. Readers only ever see a complete revision. */
  state(): DerivedState | null {
    return this.published;
  }

  /** The last ledger revision read (the published revision after a successful update). */
  lastReadRevision(): Revision {
    return this.lastRead;
  }

  /**
   * The continuation check of v32 5.2 part 5 against the published revision, or
   * null when it cannot be answered at that revision: nothing is published yet,
   * or an update has applied a newer revision that is not published yet (core
   * review r2 F5). Null is "not ready": retry, or wait for `settled()`.
   */
  continuation(req: ContinuationRequest): ContinuationResult | null {
    return this.continuationAt(req)?.result ?? null;
  }

  /** The continuation check together with the revision it answers at (one consistent read). */
  continuationAt(req: ContinuationRequest): { readonly revision: Revision; readonly result: ContinuationResult } | null {
    const pub = this.published;
    const inc = this.inc;
    if (!pub || !inc || this.inFlight !== null || inc.state().revision !== pub.revision) return null;
    return { revision: pub.revision, result: inc.continuation(req) };
  }

  /**
   * What decides each target's proof (5.2, 5.3), at the published revision, or
   * null when it cannot be read at that revision (as `continuationAt`).
   */
  decidingAt(targets: readonly string[]): { readonly revision: Revision; readonly targets: ReadonlyMap<string, DecidingView | null> } | null {
    const pub = this.published;
    const inc = this.inc;
    if (!pub || !inc || this.inFlight !== null || inc.state().revision !== pub.revision) return null;
    return { revision: pub.revision, targets: inc.deciding(targets) };
  }

  /** Resolves when no update is between applying a revision and publishing it. */
  settled(): Promise<void> {
    return this.inFlight?.done ?? Promise.resolve();
  }

  /** WI-16 notices waiting to be accepted by the ledger. */
  pendingAlertCount(): number {
    return this.pendingAlerts.length;
  }

  /** The dependency cycles of the published state (empty when it cannot be read consistently). */
  cycles(): DependencyCycle[] {
    const pub = this.published;
    const inc = this.inc;
    if (!pub || !inc || this.inFlight !== null || inc.state().revision !== pub.revision) return [];
    return inc.cycles();
  }

  /**
   * The checkpoint summary of the published state (6.1), or null before the
   * first publication. `checkpoint` is the hash of the checkpoint it is written
   * beside (binding the two).
   */
  summary(head: number | null, o: { readonly checkpoint?: string | null; readonly now?: Date } = {}): CheckpointSummary | null {
    const pub = this.published;
    if (!pub) return null;
    return summarize(pub, { head, rules: RULES_VERSION, cycles: this.cycles().length, checkpoint: o.checkpoint ?? null, ...(o.now ? { now: o.now } : {}) });
  }

  /** Resolve a batch completely before taking any of it over. */
  private resolve(batch: readonly Committed[]): Ingested {
    let chain = this.chain;
    let lastRead = this.lastRead;
    const inputs: ResolvedCommitted[] = [];
    const episodes: EpisodeChange[] = [];
    for (const c of batch) {
      chain = sha256(chain + canonicalJson(c));
      lastRead = c.revision;
      if (c.record.kind === 'episode.batch') {
        for (const ch of this.content.getList(c.record.changes)) episodes.push(JSON.parse(ch) as EpisodeChange);
      }
      if (EVALUATOR_INPUT_KINDS.has(c.record.kind)) inputs.push({ revision: c.revision, record: resolveRecord(c.record, this.content) });
    }
    return { chain, lastRead, inputs, episodes };
  }

  private takeOver(raw: readonly Committed[], ing: Ingested): void {
    // Plain loops: spreading 100,000 items into push() overflows the call stack.
    for (const c of raw) this.raw.push(c);
    for (const c of ing.inputs) {
      this.records.push(c);
      this.unapplied.push(c);
    }
    for (const e of ing.episodes) this.applyEpisode(e);
    this.chain = ing.chain;
    this.lastRead = ing.lastRead;
  }

  private applyEpisode(ch: EpisodeChange): void {
    if (ch.change === 'start') this.openEpisodes.add(ch.op);
    else this.openEpisodes.delete(ch.op);
  }

  /**
   * Episode reconciliation (6.1): an executed operation that is not all-proven
   * must have an open episode; one that is all-proven again must not. Deriving
   * changes from (state, committed episodes) instead of from transitions is what
   * makes it crash-safe: a restart recomputes the same changes.
   */
  private episodeChanges(state: DerivedState, ops: Iterable<OpId>): EpisodeChange[] {
    const changes: EpisodeChange[] = [];
    for (const op of ops) {
      const o = state.ops.get(op);
      if (!o || o.executedAsOf === null) continue;
      const open = this.openEpisodes.has(op);
      if (!o.allProven && !open) changes.push({ op, change: 'start' });
      if (o.allProven && open) changes.push({ op, change: 'end' });
    }
    return changes;
  }

  /** Run one update; updates of one instance never overlap. Throws after recording a failure. */
  update(): Promise<UpdateReport> {
    const next = this.running.then(() => this.updateOnce());
    this.running = next.catch(() => undefined);
    return next;
  }

  private async updateOnce(): Promise<UpdateReport> {
    try {
      if (this.epoch === null) this.epoch = (await this.ledger.beginEvaluator()).epoch;
      const raw = this.ledger.readRecordsAfter(this.lastRead);
      this.takeOver(raw, this.resolve(raw));
      const at = this.lastRead;
      if (this.injectComputeFault?.()) throw new Error('injected evaluator failure');
      const rebuild = this.inc === null;
      const inc = (this.inc ??= new IncrementalDerivation());
      // From here until the publication settles, `inc` is ahead of what readers may see.
      this.beginInFlight();
      const report = inc.apply(rebuild ? this.records : this.unapplied, at);
      this.unapplied = [];
      const state = report.state;
      // A rebuild reconciles every operation; otherwise only those whose state changed can need it.
      const changes = this.episodeChanges(state, rebuild ? state.ops.keys() : report.changedOps);
      let batchId: EpisodeBatchId | null = null;
      let batch: { batch: EpisodeBatchId; changes: ListRef } | null = null;
      if (changes.length > 0) {
        batchId = id<EpisodeBatchId>(`eb-${at}-${hashJson(changes).slice(0, 12)}`);
        batch = { batch: batchId, changes: this.content.putList(changes.map((c) => JSON.stringify(c))) };
      }
      await this.ledger.publish({ epoch: this.epoch, revision: at, batch });
      for (const c of changes) this.applyEpisode(c);
      this.published = state;
      this.endInFlight();
      this.queueCycleAlerts(report.newCycles);
      await this.raisePendingAlerts();
      return { published: at, changes, batch: batchId };
    } catch (e) {
      this.inc = null;
      this.unapplied = [];
      this.endInFlight();
      await this.ledger.recordEvaluatorFailure();
      throw e;
    }
  }

  private beginInFlight(): void {
    if (this.inFlight) return;
    let settle!: () => void;
    const done = new Promise<void>((r) => {
      settle = r;
    });
    this.inFlight = { done, settle };
  }

  private endInFlight(): void {
    const f = this.inFlight;
    this.inFlight = null;
    f?.settle();
  }

  // ------------------------------------------------------------ dependency-cycle notices (5.2 part 4, WI-16)

  /**
   * 5.2 part 4: "程序发现新判断使依赖成环时，写系统告警" — a cycle closed through a
   * judgment. A cycle of prerequisites alone is what a proof unit is built for
   * (5.3); its objects and its unit may arrive in separate commits, so it is
   * counted (summary) but not noticed.
   */
  private queueCycleAlerts(cycles: readonly DependencyCycle[]): void {
    if (!this.ledger.raiseAlert) return;
    for (const c of cycles) {
      if (!c.nodes.some((n) => n.startsWith('j:'))) continue;
      if (this.noticedCycles.has(c.id)) continue;
      this.noticedCycles.add(c.id);
      this.pendingAlerts.push(cycleAlert(c, this.content));
    }
  }

  /**
   * Raise the queued notices. A notice the ledger cannot take now stays queued
   * and is retried after the next update; it never fails the update (the state
   * is already published). OP_CONFLICT means the operation was already
   * committed (by an earlier instance), so it is done.
   */
  private async raisePendingAlerts(): Promise<void> {
    const raise = this.ledger.raiseAlert?.bind(this.ledger);
    if (!raise || this.pendingAlerts.length === 0) return;
    const left: AlertRequest[] = [];
    for (const a of this.pendingAlerts) {
      try {
        await raise(a);
      } catch (e) {
        if ((e as { code?: unknown }).code !== 'OP_CONFLICT') left.push(a);
      }
    }
    this.pendingAlerts = left;
  }

  // ------------------------------------------------------------ checkpoints (6.1)

  /**
   * Serialize what is needed to restart without rereading the ledger's lists:
   * the raw records read, bound to the rules version, the rule sources and a
   * hash of the body.
   */
  checkpoint(): string {
    return this.checkpointWithHash().text;
  }

  /** The checkpoint and the hash of its body (the summary written beside it names this hash). */
  checkpointWithHash(): { readonly text: string; readonly hash: ContentHash } {
    const body = canonicalJson({ rules: RULES_VERSION, code: RULES_CODE_HASH, lastRead: this.lastRead, chain: this.chain, records: this.raw });
    const hash = sha256(body);
    return { text: JSON.stringify({ body, hash }), hash };
  }

  /**
   * Restore from a checkpoint only if it is intact, was made under the same rules
   * and rule sources, its own records hash to the chain it claims, and the ledger
   * still holds exactly those records up to its revision. Its contents are then
   * re-resolved and re-derived, never trusted. Returns whether it was used.
   */
  restore(serialized: string, ledgerPrefix: readonly Committed[]): boolean {
    let cp: { rules: string; code: string; lastRead: number; chain: ContentHash; records: Committed[] };
    try {
      const outer = JSON.parse(serialized) as { body: string; hash: string };
      if (sha256(outer.body) !== outer.hash) return false;
      cp = JSON.parse(outer.body) as typeof cp;
    } catch {
      return false;
    }
    if (cp.rules !== RULES_VERSION || cp.code !== RULES_CODE_HASH) return false;
    let own = sha256('');
    for (const c of cp.records) own = sha256(own + canonicalJson(c));
    if (own !== cp.chain) return false;
    let ledger = sha256('');
    let n = 0;
    for (const c of ledgerPrefix) {
      if (c.revision > cp.lastRead) break;
      ledger = sha256(ledger + canonicalJson(c));
      n++;
    }
    if (ledger !== cp.chain || n !== cp.records.length) return false;
    let ing: Ingested;
    try {
      ing = new Evaluator(this.ledger, this.content).resolve(cp.records);
    } catch {
      return false;
    }
    this.records.splice(0, this.records.length);
    this.raw.splice(0, this.raw.length);
    this.openEpisodes.clear();
    this.inc = null;
    this.takeOver(cp.records, ing);
    this.unapplied = [];
    return true;
  }
}
