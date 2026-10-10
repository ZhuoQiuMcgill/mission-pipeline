// Shared helpers of the flows: the context of one reconciliation pass, deterministic ids, card
// defaults, contract bindings, notices with their WI, and reading basis versions.

import { canonicalJson, sha256 } from '../common/hash.ts';
import { missionIdProblem, type MissionId } from '../common/ids.ts';
import { type BaseRecord, type BasisVersionRecord, type JudgmentRecord, type ListRef, type LoopKind, type ObjectVersionRecord } from '../common/records.ts';
import type { CardBinding } from '../seat/cards/common.ts';
import { CARD_FORMAT, materialPageCount, type MaterialRef } from '../seat/cards/common.ts';
import { RUN_AREA_FLOOR_BYTES, runAreaBytes } from '../exec/resources.ts';
import type { FlowEvent, FlowEventInput, FlowNotice, FlowPorts, FlowTaskStatus, LoopStatus } from './ports.ts';

export interface FlowCtx {
  readonly ports: FlowPorts;
  readonly mission: MissionId;
  readonly now: () => number;
  /** Set when the pass did something (the engine runs passes until one does nothing). */
  progressed: boolean;
}

export function flowCtx(ports: FlowPorts, mission: MissionId): FlowCtx {
  // every derived id starts with the mission and "." (review r1 #17): refuse ids that would make them collide
  const bad = missionIdProblem(mission);
  if (bad !== null) throw new Error(bad);
  return { ports, mission, now: ports.now ?? Date.now, progressed: false };
}

/** Ids are opaque, printable, without separators (src/common/ids.ts ID): unsafe characters become "-". */
export function safeId(s: string): string {
  const t = s.replace(/[^A-Za-z0-9._:@-]/g, '-').replace(/^[^A-Za-z0-9]+/, '');
  if (t.length <= 180) return t === '' ? 'x' : t;
  return `${t.slice(0, 150)}.${sha256(t).slice(0, 16)}`;
}

/** The injective encoding of a free-form local part of a derived id (src/common/ids.ts, review r2). */
export { idPart } from '../common/ids.ts';

/** A short stable hash of any JSON value (no-progress signatures, version suffixes). */
export function shortHash(v: unknown): string {
  return sha256(typeof v === 'string' ? v : canonicalJson(v)).slice(0, 16);
}

// ---------------------------------------------------------------- events

export async function eventsOf<B>(ctx: FlowCtx, line: string, event?: string): Promise<readonly FlowEvent<B>[]> {
  return ctx.ports.ledger.events<B>({ mission: ctx.mission, line, ...(event !== undefined ? { event } : {}) });
}

export async function eventOf<B>(ctx: FlowCtx, line: string, event: string, key: string): Promise<FlowEvent<B> | null> {
  return (await eventsOf<B>(ctx, line, event)).find((e) => e.key === key) ?? null;
}

export function ev(ctx: FlowCtx, line: string, event: string, key: string, body: unknown): FlowEventInput {
  return { mission: ctx.mission, line, event, key, body };
}

/** Append (idempotent by op) and mark progress. */
export async function commit(ctx: FlowCtx, op: string, entries: { readonly events?: readonly FlowEventInput[]; readonly records?: readonly BaseRecord[] }): Promise<void> {
  await ctx.ports.ledger.append(op, entries);
  ctx.progressed = true;
}

// ---------------------------------------------------------------- notices (3.9, 3.11)

export async function notify(ctx: FlowCtx, n: Omit<FlowNotice, 'mission'>): Promise<void> {
  await ctx.ports.ledger.notify({ ...n, mission: ctx.mission });
}

/**
 * A notice that must reach the PM once (code review r1 #14): sent, then marked "told" on the
 * line. A crash between the decision that calls for it and the notice, or a failed notice, sends
 * it again on the next pass; after the mark it is not sent again (alerts are idempotent anyway).
 */
export async function tellOnce(ctx: FlowCtx, line: string, n: Omit<FlowNotice, 'mission'>): Promise<void> {
  const key = `${n.category}:${n.key}`;
  if ((await eventOf(ctx, line, 'told', key)) !== null) return;
  await notify(ctx, n);
  await commit(ctx, `flow:told:${ctx.mission}:${line}:${key}`, { events: [ev(ctx, line, 'told', key, { category: n.category, wi: n.wi })] });
}

// ---------------------------------------------------------------- records

export async function objectRecord(ctx: FlowCtx, object: string): Promise<ObjectVersionRecord | null> {
  return ctx.ports.ledger.objectVersion(object);
}

export async function judgmentRecordOf(ctx: FlowCtx, judgment: string): Promise<JudgmentRecord | null> {
  return ctx.ports.ledger.judgment(judgment);
}

/** Basis lines: their latest version and whether they are withdrawn (5.2: valid = latest and not withdrawn). */
export interface BasisIndex {
  readonly current: ReadonlyMap<string, string>;
  readonly lineOf: ReadonlyMap<string, string>;
  readonly records: ReadonlyMap<string, BasisVersionRecord>;
  readonly withdrawn: ReadonlySet<string>;
}

export async function basisIndex(ctx: FlowCtx): Promise<BasisIndex> {
  const current = new Map<string, string>();
  const lineOf = new Map<string, string>();
  const records = new Map<string, BasisVersionRecord>();
  // not filtered by mission: project-wide constraints and standards name none
  for (const c of await ctx.ports.ledger.records(['basis.version'])) {
    const r = c.record as BasisVersionRecord;
    current.set(r.line, r.version);
    lineOf.set(r.version, r.line);
    records.set(r.version, r);
  }
  const withdrawn = new Set<string>();
  for (const c of await ctx.ports.ledger.records(['basis.withdrawn'])) withdrawn.add((c.record as { line: string }).line);
  return { current, lineOf, records, withdrawn };
}

/**
 * The id of a basis line's next version for content `identity` (code review r1 #10): a
 * generation number plus the content hash, so restoring an earlier text makes a NEW current
 * version instead of naming the old one again. Null when the current version already has this
 * content.
 */
export function nextBasisVersion(ix: BasisIndex, line: string, identity: string): string | null {
  const cur = ix.current.get(line);
  if (cur !== undefined && !ix.withdrawn.has(line) && cur.slice(cur.lastIndexOf('.') + 1) === identity) return null;
  let n = 0;
  for (const r of ix.records.values()) if (r.line === line) n++;
  return safeId(`${line}.v${n + 1}.${identity}`);
}

/** The current versions of basis lines (lines without a version are skipped). */
export function currentVersions(ix: BasisIndex, lines: readonly string[]): string[] {
  const out = new Set<string>();
  for (const l of lines) {
    const v = ix.current.get(l);
    if (v !== undefined && !ix.withdrawn.has(l)) out.add(v);
  }
  return [...out].sort();
}

// ---------------------------------------------------------------- cards

export const SEAT_CAPABILITIES = ['seat', 'model'] as const;

/**
 * Default limits per tool profile (6.2, 6.5): seats without runs declare a small run peak.
 * A run seat's writable area (7.1) is sized from its writable paths when the workspace is
 * given (the copies plus room for output, exec/resources.ts runAreaBytes), else the floor
 * (RUN_AREA_FLOOR_BYTES): a flat 1 GiB put every ordinary Constructor and Reviewer over the
 * image threshold, so none could run without fuse2fs. The area stays a capped tmpfs (or an
 * image when it is that large): never uncapped.
 */
export function defaultLimits(kind: 'materials' | 'read' | 'run', workspace?: { readonly snapshot: string; readonly writablePaths: readonly string[] }): {
  run: { memoryMax: number; timeoutMs: number };
  areaBytes: number;
  export: { maxLogicalBytes: number; maxFiles: number };
  recoveryStateBytes: number;
  maxTurns: number;
} {
  const MiB = 1024 * 1024;
  if (kind === 'run') {
    const areaBytes = workspace !== undefined ? runAreaBytes(workspace.snapshot, workspace.writablePaths) : RUN_AREA_FLOOR_BYTES;
    return { run: { memoryMax: 2048 * MiB, timeoutMs: 30 * 60_000 }, areaBytes, export: { maxLogicalBytes: 256 * MiB, maxFiles: 20_000 }, recoveryStateBytes: 0, maxTurns: 400 };
  }
  return { run: { memoryMax: 256 * MiB, timeoutMs: 60_000 }, areaBytes: 64 * MiB, export: { maxLogicalBytes: 32 * MiB, maxFiles: 2_000 }, recoveryStateBytes: 0, maxTurns: kind === 'materials' ? 80 : 200 };
}

/** The common card fields (src/seat/cards/common.ts commonCardFields). */
export function cardBase(ctx: FlowCtx, task: string, o: { module?: string | null; duties: string; decisionQuotes?: readonly string[]; constraints?: ReadonlyArray<{ id: string; text: string; kind: 'object' | 'instruction' }>; limits: ReturnType<typeof defaultLimits> }) {
  return {
    format: CARD_FORMAT,
    launch: safeId(task),
    mission: ctx.mission as string,
    module: o.module ?? null,
    capabilities: [...SEAT_CAPABILITIES],
    duties: o.duties,
    decisionQuotes: [...(o.decisionQuotes ?? [])],
    constraints: [...(o.constraints ?? [])],
    limits: o.limits,
  };
}

/** A material: the document stored, its page count, must-read by default. */
export function material(ctx: FlowCtx, id: string, title: string, doc: string, mustRead = true, role?: MaterialRef['role']): MaterialRef {
  const text = doc.trim() === '' ? '(empty)' : doc;
  return { id, title, ref: ctx.ports.ledger.content.put(text), pages: materialPageCount(text), mustRead, ...(role !== undefined ? { role } : {}) };
}

/** A judgment's binding (5.2): the contract inputs, all lists stored. */
export function binding(
  ctx: FlowCtx,
  o: { judgment: string; bases: readonly string[]; reliesOn: readonly string[]; constraints?: readonly string[]; evidence?: readonly string[]; revokes?: string | null; extends?: string | null; fields?: readonly string[] },
): CardBinding {
  const c = ctx.ports.ledger.content;
  const ref = (xs: readonly string[] | undefined): ListRef => c.putList([...new Set(xs ?? [])].sort());
  return {
    judgment: o.judgment,
    bases: ref(o.bases),
    constraints: ref(o.constraints),
    reliesOn: ref(o.reliesOn),
    evidence: ref(o.evidence),
    revokes: o.revokes ?? null,
    extends: o.extends ?? null,
    evidenceUse: { fields: [...(o.fields ?? [])], statisticalOrExternal: false },
    superseded: [],
  };
}

// ---------------------------------------------------------------- task status

/** A task's outcome as the flows see it. */
export type TaskView =
  | { readonly kind: 'absent' }
  | { readonly kind: 'pending' }
  | { readonly kind: 'done'; readonly status: FlowTaskStatus; readonly result: unknown }
  | { readonly kind: 'evidence'; readonly status: FlowTaskStatus }
  | { readonly kind: 'failed'; readonly status: FlowTaskStatus; readonly why: 'needs-disposition' | 'exhausted' | 'abandoned' | 'full-review' };

export async function taskView(ctx: FlowCtx, task: string): Promise<TaskView> {
  const s = await ctx.ports.scheduler.status(task);
  if (s === null) return { kind: 'absent' };
  switch (s.state) {
    case 'queued':
    case 'running':
    case 'budget-blocked':
    case 'blocked':
      return { kind: 'pending' };
    case 'waiting-evidence':
      return { kind: 'evidence', status: s };
    case 'done':
      if (s.handBack === null || s.handBack.status !== 'handed-back') return { kind: 'failed', status: s, why: 'needs-disposition' };
      return { kind: 'done', status: s, result: s.handBack.result };
    case 'needs-disposition':
      return { kind: 'failed', status: s, why: s.disposition === 'full-review' ? 'full-review' : 'needs-disposition' };
    case 'exhausted':
      return { kind: 'failed', status: s, why: 'exhausted' };
    case 'abandoned':
      return { kind: 'failed', status: s, why: 'abandoned' };
  }
}

// ---------------------------------------------------------------- counted returns (6.5)

/**
 * One return on an automatic loop (6.5): checked before it is counted, so a cap of N allows N
 * returns ("initial + 2" reworks are 2 counted returns); two equal failure signatures in a row
 * exhaust the loop at once (no progress). Restart-safe on the real ledger (code review r1 #6):
 * the decision marker and the loop.attempt record are one atomic append (their op is the
 * marker's), and the verdict read back afterwards is kept as its own event, so a restarted flow
 * repeats exactly the same answer and never counts twice.
 */
export async function countedReturn(
  ctx: FlowCtx,
  o: { readonly line: string; readonly key: string; readonly lineage: string; readonly loop: LoopKind; readonly signature: string },
): Promise<{ readonly proceed: boolean; readonly status: LoopStatus }> {
  const kept = (await eventOf<{ proceed: boolean }>(ctx, o.line, 'loop-verdict', o.key))?.body ?? null;
  if (kept !== null) return { proceed: kept.proceed, status: await ctx.ports.ledger.loop(o.lineage, o.loop) };
  let marker = (await eventOf<{ decision: 'try' | 'exhausted' }>(ctx, o.line, 'loop-return', o.key))?.body ?? null;
  if (marker === null) {
    const pre = await ctx.ports.ledger.loop(o.lineage, o.loop);
    marker = { decision: pre.exhausted ? 'exhausted' : 'try' };
    await commit(ctx, `flow:return:${ctx.mission}:${o.line}:${o.key}`, {
      events: [ev(ctx, o.line, 'loop-return', o.key, { ...marker, lineage: o.lineage, loop: o.loop, signature: o.signature })],
      records: marker.decision === 'try' ? [{ kind: 'loop.attempt', lineage: o.lineage, loop: o.loop, failureClass: null, signature: o.signature }] : [],
    });
  }
  const status = await ctx.ports.ledger.loop(o.lineage, o.loop);
  const proceed = marker.decision === 'try' && status.reason !== 'no-progress';
  await commit(ctx, `flow:return-verdict:${ctx.mission}:${o.line}:${o.key}`, { events: [ev(ctx, o.line, 'loop-verdict', o.key, { proceed, attempts: status.attempts, allowed: status.allowed, reason: status.reason })] });
  return { proceed, status };
}
