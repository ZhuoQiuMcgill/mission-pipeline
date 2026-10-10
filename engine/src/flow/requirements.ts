// The requirement hub (design 3.1) and the important-decision routing (3.2).
//
// 3.1: the user's words are booked by the PM session's prompt hook (user.words, elsewhere).
// Requirement items are typed (goal, limit, authorization, acceptance standard, decision), each
// with its provenance (the quoted words of a message; a decision points at the authorization it
// rests on), versioned item by item; states: valid, replaced, withdrawn, contested. Every item
// version is a basis version (5.2), and every change of the item set makes a new version of the
// mission's requirement set (v31), whose snapshot lists the item versions in force. The item's
// words and provenance are a flow event on the "requirements" line (basis.version has no text).
// Withdraw- and prohibit-type words also trigger the hard stop of 6.4: that is the prompt hook's
// stop detection (src/cli/stopDetect.ts), not this module.
//
// Project constraints (9.5) are basis lines too (object constraints and execution instructions)
// with their scope; their text is a flow event of the same line.
//
// 3.2: only three kinds of decision reach the user; a decision whose reversibility is unclear
// is treated as hard to undo (the related action pauses); a clearly reversible one the user may
// or may not care about is a detail with the "may matter" note in layer 2.

import { ITEM_ID, type BasisLineId, type BasisVersionId, type MissionId } from '../common/ids.ts';
import type { BaseRecord, BasisVersionRecord, ConstraintScope } from '../common/records.ts';
import { canonicalJson } from '../common/hash.ts';
import { basisIndex, commit, ev, eventsOf, flowCtx, nextBasisVersion, safeId, shortHash, type BasisIndex, type FlowCtx } from './context.ts';
import { REQUIREMENTS_LINE } from './plandoc.ts';
import type { FlowEvent, FlowPorts } from './ports.ts';

export type ItemType = 'goal' | 'limit' | 'authorization' | 'acceptance' | 'decision';

export type ItemSource =
  /** The user's words: the booked message and the quoted span. */
  | { readonly kind: 'words'; readonly message: string; readonly quote: string }
  /** A decision: the authorization line it rests on. */
  | { readonly kind: 'authorization'; readonly line: string };

export interface ItemVersionBody {
  readonly line: string;
  readonly version: string;
  readonly type: ItemType;
  readonly text: string;
  readonly source: ItemSource;
  /** The PM's restatement and the user's confirming message, kept as a pair (3.1). */
  readonly restatement: string | null;
  readonly confirmedBy: string | null;
  /** For an authorization: when the user wants to be told (3.8 "告知条件"). */
  readonly notifyCondition: string | null;
}

export interface ConstraintBody {
  readonly line: string;
  readonly version: string;
  readonly kind: 'object' | 'instruction';
  readonly text: string;
  readonly scope: ConstraintScope;
}

export interface CurrentItem extends ItemVersionBody {
  readonly state: 'valid' | 'contested';
}

/** The mission's requirement-set line (v31 5.2). */
export const requirementSetLine = (mission: string): string => safeId(`reqset.${mission}`);

/**
 * Item and constraint ids go into their ledger lines as they are (ITEM_ID: no "." and nothing
 * safeId would rewrite; review r2, r3: "R!1" became "R-1" and withdrew the wrong item).
 */
function localIdCheck(what: string, v: string): void {
  if (typeof v !== 'string' || !ITEM_ID.test(v)) throw new Error(`${what} id ${JSON.stringify(v)} is not allowed: use 1 to 64 letters, digits or "-", starting with a letter or digit`);
}

/**
 * Every basis line starts with a fixed kind ("item.", "constraint.", "std.", "reqset.", "xpdef."),
 * so lines of different kinds never meet (review r3: mission "constraint" with item "security" was
 * the line of the project constraint "security").
 */
export function itemLine(mission: string, item: string): string {
  localIdCheck('item', item);
  return `item.${mission}.${item}`;
}
export function constraintLine(constraint: string): string {
  localIdCheck('constraint', constraint);
  return `constraint.${constraint}`;
}

/** The basis kinds of requirement items (BASIS_KIND below). */
const ITEM_KINDS: ReadonlySet<string> = new Set(['requirement', 'authorization', 'standard']);

/** The current record of a line, refused unless it is of the expected kind (and mission): a write never lands on another kind's line. */
function checkKind(ix: BasisIndex, line: string, what: string, kinds: ReadonlySet<string>, mission: string | null): BasisVersionRecord | null {
  const cur = ix.current.get(line);
  if (cur === undefined) return null;
  const rec = ix.records.get(cur);
  if (rec === undefined || !kinds.has(rec.basisKind) || (mission !== null && rec.mission !== mission)) {
    throw new Error(`${line} is not ${what}${mission !== null ? ` of mission ${mission}` : ''} (it is a ${rec?.basisKind ?? 'unknown'} line${rec?.mission != null ? ` of mission ${rec.mission}` : ''}): nothing was written`);
  }
  return rec;
}

const BASIS_KIND: Readonly<Record<ItemType, Exclude<BasisVersionRecord['basisKind'], 'requirement-set'>>> = {
  goal: 'requirement',
  limit: 'requirement',
  decision: 'requirement',
  authorization: 'authorization',
  acceptance: 'standard',
};

/** The requirement items in force (latest version of each line, not withdrawn). */
export async function currentItems(ctx: FlowCtx): Promise<CurrentItem[]> {
  const ix = await basisIndex(ctx);
  const latest = new Map<string, ItemVersionBody>();
  for (const e of await eventsOf<ItemVersionBody>(ctx, REQUIREMENTS_LINE, 'item')) latest.set(e.body.line, e.body);
  const contested = new Set<string>();
  for (const e of await eventsOf<{ line: string; contested: boolean }>(ctx, REQUIREMENTS_LINE, 'contested')) {
    if (e.body.contested) contested.add(e.body.line);
    else contested.delete(e.body.line);
  }
  return [...latest.values()]
    .filter((b) => !ix.withdrawn.has(b.line) && ix.current.get(b.line) === b.version)
    .map((b) => ({ ...b, state: contested.has(b.line) ? ('contested' as const) : ('valid' as const) }));
}

/** The requirement set's new version: a snapshot of the item versions in force (all five types). */
async function requirementSetVersion(ctx: FlowCtx, items: readonly { line: string; version: string }[]): Promise<BaseRecord> {
  const ix = await basisIndex(ctx);
  const line = requirementSetLine(ctx.mission);
  const prev = ix.current.get(line);
  const n = prev === undefined ? 1 : Number(prev.slice(prev.lastIndexOf('.v') + 2)) + 1;
  return {
    kind: 'basis.version',
    basisKind: 'requirement-set',
    line: line as BasisLineId,
    version: safeId(`${line}.v${n}`) as BasisVersionId,
    mission: ctx.mission,
    scope: null,
    snapshot: ctx.ports.ledger.content.putList(items.map((i) => i.version).sort()),
  };
}

/**
 * Record a new item, or a new version of an item (3.1). Returns the version id. The op id is
 * derived from the item's content, so recording the same version twice is one operation.
 */
export async function recordItem(
  ports: FlowPorts,
  req: {
    readonly mission: MissionId;
    readonly item: string;
    readonly type: ItemType;
    readonly text: string;
    readonly source: ItemSource;
    readonly restatement?: string;
    readonly confirmedBy?: string;
    readonly notifyCondition?: string;
  },
): Promise<string> {
  const ctx = flowCtx(ports, req.mission);
  const line = itemLine(req.mission, req.item);
  const ix = await basisIndex(ctx);
  checkKind(ix, line, 'a requirement item', ITEM_KINDS, req.mission);
  const prev = ix.current.get(line);
  const prevBody = (await eventsOf<ItemVersionBody>(ctx, REQUIREMENTS_LINE, 'item')).filter((e) => e.body.line === line).at(-1)?.body ?? null;
  const identity = shortHash({ type: req.type, text: req.text, source: req.source });
  if (prevBody !== null && prev === prevBody.version && shortHash({ type: prevBody.type, text: prevBody.text, source: prevBody.source }) === identity && !ix.withdrawn.has(line)) return prev;
  const n = prev === undefined ? 1 : Number(prev.slice(prev.lastIndexOf('.v') + 2)) + 1;
  const version = safeId(`${line}.v${n}`);
  const body: ItemVersionBody = {
    line,
    version,
    type: req.type,
    text: req.text,
    source: req.source,
    restatement: req.restatement ?? null,
    confirmedBy: req.confirmedBy ?? null,
    notifyCondition: req.notifyCondition ?? null,
  };
  const items = (await currentItems(ctx)).filter((i) => i.line !== line).map((i) => ({ line: i.line, version: i.version }));
  items.push({ line, version });
  const rec: BaseRecord = { kind: 'basis.version', basisKind: BASIS_KIND[req.type], line: line as BasisLineId, version: version as BasisVersionId, mission: req.mission, scope: null };
  await commit(ctx, `flow:item:${req.mission}:${version}`, { events: [ev(ctx, REQUIREMENTS_LINE, 'item', version, body)], records: [rec, await requirementSetVersion(ctx, items)] });
  return version;
}

/** Withdraw an item (3.1): the line is withdrawn and the requirement set gets a new version. */
export async function withdrawItem(ports: FlowPorts, req: { readonly mission: MissionId; readonly item: string; readonly reason: string }): Promise<void> {
  const ctx = flowCtx(ports, req.mission);
  const line = itemLine(req.mission, req.item);
  const ix = await basisIndex(ctx);
  if (ix.withdrawn.has(line)) return; // already withdrawn: a retry
  // only an existing requirement item of this mission (review r3): anything else is refused, nothing written
  if (checkKind(ix, line, 'a requirement item', ITEM_KINDS, req.mission) === null) throw new Error(`mission ${req.mission} has no requirement item ${req.item}: nothing was withdrawn`);
  const items = (await currentItems(ctx)).filter((i) => i.line !== line).map((i) => ({ line: i.line, version: i.version }));
  await commit(ctx, `flow:withdraw:${req.mission}:${line}`, {
    events: [ev(ctx, REQUIREMENTS_LINE, 'withdrawn', line, { line, reason: req.reason })],
    records: [{ kind: 'basis.withdrawn', line: line as BasisLineId }, await requirementSetVersion(ctx, items)],
  });
}

/** Mark an item contested, or release it (3.3: not used downstream while contested). */
export async function setContested(ctx: FlowCtx, line: string, contested: boolean, why: string): Promise<void> {
  const prior = (await eventsOf<{ line: string; contested: boolean }>(ctx, REQUIREMENTS_LINE, 'contested')).filter((e) => e.body.line === line);
  const n = prior.length;
  if ((prior.at(-1)?.body.contested ?? false) === contested) return;
  await commit(ctx, `flow:contested:${ctx.mission}:${line}:${n + 1}`, { events: [ev(ctx, REQUIREMENTS_LINE, 'contested', `${line}#${n + 1}`, { line, contested, why })] });
}

/**
 * Record a project constraint (9.5): an object constraint or an execution instruction, with its
 * scope. Its content version is its text and kind (code review r1 #9, #10: a kind change or a
 * restored earlier text is a new current version); a scope change alone keeps the version and is
 * a constraint.scope record (v30 5.2: narrowing a scope does not degrade what it still covers).
 */
export async function recordConstraint(
  ports: FlowPorts,
  req: { readonly mission: MissionId; readonly constraint: string; readonly kind: 'object' | 'instruction'; readonly text: string; readonly scope: ConstraintScope },
): Promise<string> {
  const ctx = flowCtx(ports, req.mission);
  const line = constraintLine(req.constraint);
  const ix = await basisIndex(ctx);
  checkKind(ix, line, 'a project constraint', new Set(['constraint', 'instruction']), null);
  const version = nextBasisVersion(ix, line, shortHash({ text: req.text, kind: req.kind }));
  if (version === null) {
    const cur = ix.current.get(line) as string;
    const latest = (await currentConstraints(ctx)).find((c) => c.line === line);
    if (latest !== undefined && canonicalJson(latest.scope) === canonicalJson(req.scope)) return cur;
    // counted over every mission: the op id is project-wide like the line (9.5)
    const n = (await projectEvents(ctx, 'constraint-scope')).filter((e) => (e.body as { line: string }).line === line).length + 1;
    await commit(ctx, `flow:constraint-scope:${req.mission}:${line}:${n}`, {
      events: [ev(ctx, REQUIREMENTS_LINE, 'constraint-scope', `${line}#${n}`, { line, version: cur, scope: req.scope })],
      records: [{ kind: 'constraint.scope', line: line as BasisLineId, scope: req.scope }],
    });
    return cur;
  }
  const body: ConstraintBody = { line, version, kind: req.kind, text: req.text, scope: req.scope };
  await commit(ctx, `flow:constraint:${req.mission}:${version}`, {
    events: [ev(ctx, REQUIREMENTS_LINE, 'constraint', version, body)],
    records: [{ kind: 'basis.version', basisKind: req.kind === 'object' ? 'constraint' : 'instruction', line: line as BasisLineId, version: version as BasisVersionId, mission: req.mission, scope: req.scope }],
  });
  return version;
}

/**
 * Constraint events of every mission, in ledger order. Constraints are project constraints (9.5):
 * one line per constraint whichever mission recorded it, so a version or scope recorded from one
 * mission is in force for all; each card takes them by the constraint's own scope.
 */
async function projectEvents<B>(ctx: FlowCtx, event: 'constraint' | 'constraint-scope'): Promise<FlowEvent<B>[]> {
  const missions = new Set<MissionId>([ctx.mission, ...(await ctx.ports.ledger.missions())]);
  const all = await Promise.all([...missions].map((m) => ctx.ports.ledger.events<B>({ mission: m, line: REQUIREMENTS_LINE, event })));
  return all.flat().sort((a, b) => a.revision - b.revision);
}

/** The project constraints in force (9.5, recorded from any mission): the latest content version of each line, with its latest scope. */
export async function currentConstraints(ctx: FlowCtx): Promise<ConstraintBody[]> {
  const ix = await basisIndex(ctx);
  const latest = new Map<string, { body: ConstraintBody; revision: number }>();
  for (const e of await projectEvents<ConstraintBody>(ctx, 'constraint')) {
    if (ix.current.get(e.body.line) === e.body.version && !ix.withdrawn.has(e.body.line)) latest.set(e.body.line, { body: e.body, revision: e.revision });
  }
  for (const e of await projectEvents<{ line: string; version: string; scope: ConstraintScope }>(ctx, 'constraint-scope')) {
    const l = latest.get(e.body.line);
    if (l !== undefined && e.revision > l.revision) latest.set(e.body.line, { body: { ...l.body, scope: e.body.scope }, revision: e.revision });
  }
  return [...latest.values()].map((x) => x.body);
}

// ---------------------------------------------------------------- 3.2 important design decisions

export interface DecisionFacts {
  /** Kind 1: changes what the user gets (scope, delivery form, visible behaviour). */
  readonly changesDeliverable: boolean;
  /** Kind 2: whether it can be undone afterwards. */
  readonly reversible: 'yes' | 'no' | 'unclear';
  /** Kind 3: conflicts with the user's words. */
  readonly conflictsWithUser: boolean;
  /** Whether the user might care (for a clearly reversible detail). */
  readonly userMayCare: boolean;
}

export type DecisionRoute =
  /** Before the user: the related action pauses. */
  | { readonly kind: 'user'; readonly why: 'deliverable' | 'irreversible' | 'conflict'; readonly pause: true }
  /** A detail: layer 2 only, with the "may matter" note when the user might care. */
  | { readonly kind: 'detail'; readonly mayMatter: boolean };

/** 3.2: what reaches the user. Conflicts always go up; unclear reversibility counts as irreversible. */
export function routeDecision(f: DecisionFacts): DecisionRoute {
  if (f.conflictsWithUser) return { kind: 'user', why: 'conflict', pause: true };
  if (f.changesDeliverable) return { kind: 'user', why: 'deliverable', pause: true };
  if (f.reversible !== 'yes') return { kind: 'user', why: 'irreversible', pause: true };
  return { kind: 'detail', mayMatter: f.userMayCare };
}
