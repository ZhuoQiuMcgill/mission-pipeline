// 4.4 (G3, the plan's F1 and F13): two reads of what reaches a mission's work.
//
//   mp read constraints <mission> [--reach]   each constraint in force for the mission with its author (PM or
//                                             Secretary), its address or scope, and with --reach the tasks whose
//                                             cards it reaches, its size and the Reviewers' answers to it
//   mp read repairs <mission>                 each repair with its kind, words, subject and the Architect's note;
//                                             the tasks it added, changed and reopened with their state; its
//                                             dispatches; and a derived "done"
//
// Each read takes one snapshot of the memory (every row it derives from is read in one transaction).

import type { BaseRecord, ObjectVersionRecord } from '../common/records.ts';
import { idPart, type MissionId } from '../common/ids.ts';
import { canonicalJson } from '../common/hash.ts';
import { safeId } from '../flow/context.ts';
import { flowEvents, flowMissions, recordsByKind, factById, type Db } from '../memory/index.ts';
import type { DataStore } from '../memory/data.ts';
import { resolveBases, resolveConstraints } from '../memory/domain/constraints.ts';
import { constraintAuthor, planSetItems, type ConstraintBody } from '../flow/requirements.ts';
import { DetailedPlanDoc, amendedPlan, latestEffectiveOf, REOPEN_NOT_CARRIED, REPAIR_ENDED, taskCardHash, type AmendmentEntry, type DetailedPlanDoc as Plan, type RepairBody, type RepairDecidedBody, type StoredDetailedPlan } from '../flow/plandoc.ts';
import type { FlowEvent } from '../flow/ports.ts';
import type { EscalationBody } from '../flow/secretary.ts';
import { addressee, constraintsForTask, forRepairArchitect, isAddressed, noteOfHandBack, planInEffect, repairNoteOf, repairReopensCarried, reopenRecordState, type ReopenRecordState } from '../seat/cards/dynamic.ts';
import { taskStatus } from '../process/ports.ts';
import { currentRiskEscalation, lineAcceptance, taskLineage } from '../flow/execution.ts';
import { repairLineage } from '../flow/repair.ts';
import { ATTEMPT_RERUN, ATTEMPTS_AMENDED, RESNAPSHOTTED } from '../flow/exploration/machine.ts';
import { riskItemsOf } from '../flow/riskItems.ts';

function pages<T extends { revision: number }>(read: (after: number) => readonly T[]): T[] {
  const out: T[] = [];
  let after = 0;
  for (;;) { const rows = read(after); if (rows.length === 0) return out; out.push(...rows); after = rows.at(-1)!.revision; }
}

interface Snapshot {
  readonly events: FlowEvent[];
  readonly constraints: ConstraintBody[];
  readonly plan: Plan | null;
  readonly dispatches: Array<{ dispatch: string; task: string; seat: string; state: string; lineage: string; rev: number }>;
  /** 4.4 (G9): the PM plan in effect and the item lines its check is bound to (null: no plan in effect). */
  readonly checked: { readonly plan: string; readonly items: ReadonlySet<string> } | null;
}

function snapshot(db: Db, data: DataStore, mission: string): Snapshot {
  const parse = (e: { revision: number; mission: string; line: string; event: string; key: string; body: string }): FlowEvent => ({ ...e, body: JSON.parse(data.text(e.body)) } as FlowEvent);
  const events = pages((after) => flowEvents(db, { mission: mission as MissionId, after })).map(parse);
  // constraints are the project's (9.5): a version recorded from any mission is in force for all
  const constraintEvents = flowMissions(db).flatMap((m) => (m === mission ? events.filter((e) => e.line === 'requirements') : pages((after) => flowEvents(db, { mission: m, line: 'requirements', after })).map(parse))).sort((a, b) => a.revision - b.revision);
  const ix = resolveBases(pages((after) => recordsByKind(db, { kinds: ['basis.version', 'basis.withdrawn'], after })).map((r) => r.record as BaseRecord));
  const constraints = resolveConstraints(ix, constraintEvents).filter((c) => c.scope.mission === undefined || c.scope.mission === mission);
  const eff = planInEffect(events);
  const obj = eff === undefined ? undefined : (factById(db, 'object.version', eff.dplan)?.record as ObjectVersionRecord | undefined);
  const plan = eff === undefined || obj === undefined ? null : amendedPlan(DetailedPlanDoc.parse((JSON.parse(data.text(obj.content)) as StoredDetailedPlan).plan), eff.amendments);
  const dispatches = (db.stmt('SELECT dispatch, task, seat, state, lineage, claimed_rev FROM dispatches WHERE mission = ? ORDER BY claimed_rev').all(mission) as Array<{ dispatch: string; task: string; seat: string; state: string; lineage: string; claimed_rev: number }>).map((d) => ({ ...d, rev: Number(d.claimed_rev) }));
  const pm = eff === undefined ? undefined : (factById(db, 'object.version', eff.pmPlan)?.record as ObjectVersionRecord | undefined);
  const checked = eff === undefined || pm === undefined ? null : { plan: eff.pmPlan, items: planSetItems(pm, ix, (r) => data.getList(r)) };
  return { events, constraints, plan, dispatches, checked };
}

const clip = (s: string, n: number): string => { const t = s.replace(/\s+/g, ' ').trim(); return t.length <= n ? t : `${t.slice(0, n - 1)}…`; };
const lineOf = (s: Snapshot, task: string): FlowEvent[] => s.events.filter((e) => e.line === `task:${task}`);

/** 4.4 (p6-r2-1): the duties of the claimed cards of one attempt of a task: its Constructor's and its Reviewers'. */
function attemptDuties(s: Snapshot, data: DataStore, mission: string, task: string, k: number): string[] {
  const con = safeId(`con.${mission}.${idPart(task)}.${k}`);
  const rev = safeId(`rev.${mission}.${idPart(task)}.${k}`);
  const out: string[] = [];
  for (const d of s.dispatches.filter((x) => x.task === con || x.task === rev || x.task.startsWith(`${rev}.r`))) {
    const claimed = s.events.find((e) => e.line === `dispatch:${d.dispatch}` && e.event === 'claimed' && e.key === 'spec');
    if (claimed === undefined) continue;
    try {
      const duties = (JSON.parse(data.text((claimed.body as { spec: string }).spec)) as { card?: { duties?: string } }).card?.duties;
      if (typeof duties === 'string') out.push(duties);
    } catch {
      /* an unreadable card shows nothing */
    }
  }
  return out;
}

/** 4.4 (G3): the version of an instruction the claimed card of a step's handed-back dispatch showed, or null (no such card). */
function cardVersion(s: Snapshot, data: DataStore, step: string, line: string): string | null {
  const d = s.dispatches.filter((x) => x.task === step && x.state === 'handed-back').at(-1);
  const claimed = d === undefined ? undefined : s.events.find((e) => e.line === `dispatch:${d.dispatch}` && e.event === 'claimed' && e.key === 'spec');
  if (claimed === undefined) return null;
  try {
    const card = (JSON.parse(data.text((claimed.body as { spec: string }).spec)) as { card?: { addressed?: Array<{ id: string; version: string }> } }).card;
    return card?.addressed?.find((a) => a.id === line)?.version ?? null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- mp read constraints

export interface ConstraintRead {
  readonly id: string;
  readonly version: string;
  readonly kind: 'object' | 'instruction';
  readonly author: 'pm' | 'secretary';
  readonly words: string | null;
  /** The address (tasks, repairs) or, without one, the paths and task types. */
  readonly address: { readonly tasks: readonly string[]; readonly repairs: readonly string[] } | null;
  readonly scope: { readonly paths: readonly string[]; readonly taskTypes: readonly string[] };
  readonly first: string;
  readonly bytes: number;
  /** With --reach: the tasks of the plan in effect whose cards print it, and the undecided repairs whose Architect card does. */
  readonly reach?: { readonly tasks: readonly string[]; readonly architects: readonly string[] };
  /** With --reach, an addressed instruction: each task's latest Reviewer answer to it. */
  readonly answers?: ReadonlyArray<{ readonly task: string; readonly review: string; readonly response: string; readonly reason: string }>;
}

export function constraintsRead(db: Db, data: DataStore, mission: string, reach: boolean): { mission: string; constraints: ConstraintRead[]; bytes: number } {
  const s = snapshot(db, data, mission);
  const decided = new Map(s.events.filter((e) => e.line === 'repairs' && e.event === 'decided').map((e) => [e.key, e.body as RepairDecidedBody]));
  const repairs = s.events.filter((e) => e.line === 'repairs' && e.event === 'repair').map((e) => e.body as RepairBody);
  const out = s.constraints.map((c): ConstraintRead => {
    const addressed = isAddressed(c);
    const base: ConstraintRead = { id: c.line, version: c.version, kind: c.kind, author: constraintAuthor(c), words: c.words ?? null, address: addressed ? { tasks: [...(c.scope.tasks ?? [])], repairs: [...(c.scope.repairs ?? [])] } : null, scope: { paths: [...c.scope.paths], taskTypes: [...c.scope.taskTypes] }, first: clip(c.text.split('\n')[0] ?? '', 120), bytes: Buffer.byteLength(c.text, 'utf8') };
    if (!reach) return base;
    const tasks = s.plan?.tasks ?? [];
    if (!addressed) return { ...base, reach: { tasks: tasks.filter((t) => constraintsForTask([c], t, mission).length > 0).map((t) => t.id), architects: [] } };
    const named = new Set(c.scope.tasks ?? []);
    for (const r of c.scope.repairs ?? []) { const d = decided.get(r); for (const t of d === undefined ? [] : [...d.add, ...(d.changed ?? []), ...d.reopen.map((x) => x.task)]) named.add(t); }
    const answers: Array<{ task: string; review: string; response: string; reason: string }> = [];
    for (const t of tasks.filter((x) => named.has(x.id))) {
      // 4.4 (G3, p6-5): an answer counts for the version its claimed card showed (an older answer without one: its card's)
      const latest = lineOf(s, t.id).filter((e) => e.event === 'review').map((e) => e.body as { task: string; instructions?: Array<{ instruction: string; version?: string; response: string; reason: string }> })
        .flatMap((b) => (b.instructions ?? []).filter((i) => i.instruction === c.line && (i.version ?? cardVersion(s, data, b.task, c.line)) === c.version).map((i) => ({ task: t.id, review: b.task, response: i.response, reason: i.reason }))).at(-1);
      if (latest !== undefined) answers.push(latest);
    }
    // 4.4 (p6-8): an undecided repair's Architect card prints it in full by the card's own rule (the repair, or the task it is about)
    const architects = repairs.filter((r) => !decided.has(r.id) && r.about?.kind !== 'exploration' && forRepairArchitect(c, { repair: r.id, ...(r.about?.kind === 'task' ? { about: r.about.id } : {}) })).map((r) => r.id);
    return { ...base, reach: { tasks: tasks.filter((t) => named.has(t.id)).map((t) => t.id), architects }, answers };
  });
  return { mission, constraints: out, bytes: out.reduce((n, c) => n + c.bytes, 0) };
}

export function constraintsText(r: ReturnType<typeof constraintsRead>, reach: boolean): string {
  const cs = r.constraints;
  if (cs.length === 0) return `Mission ${r.mission} has no constraint in force.`;
  const count = (f: (c: ConstraintRead) => boolean): number => cs.filter(f).length;
  const lines = [`Constraints in force for mission ${r.mission}: ${cs.length} (${count((c) => c.kind === 'object')} object, ${count((c) => c.kind === 'instruction')} instruction; the Secretary's ${count((c) => c.author === 'secretary')}; addressed ${count((c) => c.address !== null)}), ${r.bytes} bytes of text${reach ? '' : ' (--reach: the cards each reaches, and the Reviewers\' answers)'}`];
  for (const c of cs) {
    const where = c.address !== null ? `addressed to ${addressee(c.address)}` : `scope ${c.scope.paths.join(', ')}${c.scope.taskTypes.length > 0 ? ` for ${c.scope.taskTypes.join(', ')}` : ''}`;
    lines.push(`[${c.id}] ${c.kind}, ${c.author === 'secretary' ? 'the Secretary\'s' : 'the PM\'s'}${c.words !== null ? ` on ${c.words}` : ''}, ${where}: ${c.first}`);
    if (c.reach === undefined) continue;
    lines.push(`    reaches the cards of ${c.reach.tasks.length} task${c.reach.tasks.length === 1 ? '' : 's'}${c.reach.tasks.length > 0 ? ` (${c.reach.tasks.slice(0, 10).join(', ')}${c.reach.tasks.length > 10 ? ', …' : ''})` : ''}${c.reach.architects.length > 0 ? ` and the Architect card of repair ${c.reach.architects.join(', ')}` : ''}; ${c.bytes} bytes; version ${c.version}`);
    for (const a of c.answers ?? []) lines.push(`    the Reviewer of ${a.task} (${a.review}): ${a.response}: ${clip(a.reason, 160)}`);
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------- mp read repairs

/**
 * A task a repair added, changed or reopened, and its state. Neither open nor done: `superseded` (a changed card
 * another card of the task replaced before any acceptance under it: the repair that replaced it, or "a later plan"),
 * `notRecorded` (a 4.3 reopen the record does not show the outcome of), `notCarried` (a reopen not carried out).
 */
export interface RepairTaskState {
  readonly task: string;
  readonly state: string;
  readonly done: boolean;
  readonly superseded?: string;
  readonly notRecorded?: true;
  readonly notCarried?: true;
  /**
   * 4.4 (final review F3-1, F4-1): the attempt the part is credited with (the accepted attempt that carried the repair:
   * its card, or the repair's issue), its product and the risk it was accepted with (its escalation; null: none). A read
   * takes the acceptance, the risk, the proof and the delivery from this product, never from a later attempt's.
   */
  readonly credited?: Credit;
}

/** An accepted attempt of a task, with its product and the escalation it was accepted with risk on (null: none). */
export interface Credit { readonly attempt: number; readonly product: string; readonly risk: string | null }

/** The parts of a decided repair that are not done, by what the record establishes of each. */
export interface RepairParts {
  readonly open: readonly string[];
  readonly superseded: ReadonlyArray<{ readonly part: string; readonly by: string }>;
  readonly notRecorded: readonly string[];
  readonly notCarried: readonly string[];
}

export interface RepairRead {
  readonly id: string;
  readonly kind: string;
  readonly words: string;
  readonly text: string;
  readonly about: string | null;
  /** 4.4 (G9): "ended": a filing whose every item was withdrawn before its amendment was applied. */
  readonly state: 'waiting' | 'architect' | 'decided' | 'exploration' | 'answered' | 'ended';
  /** 4.4 (G9): "extend": a new requirement's filing; null: a repair. */
  readonly entry: 'extend' | null;
  /** 4.4 (G9): the requirement items its work is bound to (a new requirement's, or the one a repair falls short of), with their state. */
  readonly items: ReadonlyArray<{ readonly id: string; readonly state: 'in force' | 'withdrawn' }>;
  /** 4.4 (G9): the PM plan in effect, and whether its check is bound to each in-force item of the filing (`inside`), from its contract's sets. */
  readonly checkedBy: { readonly plan: string; readonly inside: readonly string[] } | null;
  /** 4.4 (G9): a repair that added tasks and names no item (a lead for a spot-check: was it a new requirement?). */
  readonly addedNoItem: boolean;
  /** 4.4 (G9): with several items, the tasks it added, changed or reopened on which its Architect named none of them (bound to none). */
  readonly unnamed: readonly string[];
  /**
   * 4.4 (F13): filed again: with `--again` (`flag`, its operation recorded with it), and the same repair (words, kind,
   * text and subject) filed before it (`of`, null: none). Null: neither.
   */
  readonly filedAgain: { readonly flag: boolean; readonly of: string | null } | null;
  /**
   * The Architect's note on its decision ("" when it gave none); a decision 4.3 recorded has none, and its note is
   * the one in its Architect step's accepted hand-back. Null: not decided, or no note recorded or readable.
   */
  readonly note: string | null;
  /** 4.4: decided by 4.3 (its reopens carry no `tracked`; a decision with none carries no note). */
  readonly under43: boolean;
  /**
   * The parts of a decided repair that are not done: open (work that may still be done), superseded (a changed card
   * replaced before it was accepted, with what replaced it), not recorded (4.3), not carried out (a reopen). The line
   * says them instead of "not done". Null: not decided, or about an exploration.
   */
  readonly parts: RepairParts | null;
  /** The Architect's question waiting for the PM (4.4, G4), with its escalation. */
  readonly question: { readonly escalation: string; readonly text: string } | null;
  readonly added: readonly RepairTaskState[];
  readonly changed: readonly RepairTaskState[];
  readonly reopened: readonly RepairTaskState[];
  /** The instructions addressed to it. */
  readonly instructions: readonly string[];
  /** The dispatches of its Architect steps (and their decisions), and the count of dispatches on its tasks since its decision. */
  readonly dispatches: ReadonlyArray<{ readonly dispatch: string; readonly seat: string; readonly state: string }>;
  readonly taskDispatches: number;
  /**
   * Derived: every added task accepted; every changed task accepted at some attempt under the spec that carries the
   * repair, whatever came later (one whose card another card replaced before any such acceptance is superseded:
   * neither open nor done; an acceptance under an unrelated spec never counts); every reopened
   * task accepted at the attempt its reopen opened or later (4.4: by its `reopen-carried` record, once a seat took that
   * attempt; a reopen waiting or not carried out is not done; 4.3, no record: 4.3 counted the reopen on the task's
   * loop, or an attempt's card carried its issue, and the task is accepted at a later attempt than the decision's).
   * Null: not a repair of the plan's tasks, or not decided.
   */
  readonly done: boolean | null;
  /**
   * 4.4 (G4, G5): the open items the repair names (`--open-items`) or its decision gave to a task: the tasks of its
   * decision that took each (none: it stays open, given to no task) and whether it is closed now. Absent: none.
   */
  readonly openItems?: ReadonlyArray<{ readonly id: string; readonly named: boolean; readonly takenBy: readonly string[]; readonly closed: boolean }>;
}

/**
 * The same repair (flow/repair.ts recordRepair): the same words, kind, text and subject (4.4: and the open items it names;
 * G9: never a new requirement's filing, and the same item named, none: as 4.3).
 */
const sameRepair = (a: RepairBody, b: RepairBody): boolean => a.words === b.words && a.kind === b.kind && a.text === b.text && canonicalJson(a.about) === canonicalJson(b.about) && canonicalJson(a.openItems ?? []) === canonicalJson(b.openItems ?? []) && a.entry === undefined && b.entry === undefined && canonicalJson(a.items ?? null) === canonicalJson(b.items ?? null);

/** Whether a seat took attempt k of a task (as execution.ts attemptTaken): it was reviewed, or a dispatch of its Constructor or Reviewer exists. */
function attemptTaken(s: Snapshot, mission: string, task: string, line: readonly FlowEvent[], k: number): boolean {
  if (line.some((e) => e.event === 'review' && (e.body as { k?: number }).k === k)) return true;
  const con = safeId(`con.${mission}.${idPart(task)}.${k}`);
  const rev = safeId(`rev.${mission}.${idPart(task)}.${k}`);
  return s.dispatches.some((d) => d.task === con || d.task === rev || d.task.startsWith(`${rev}.r`));
}

/** 4.4 (F13): a reopen 4.4 tracks as the read of repairs says it, from its records (seat/cards/dynamic.ts reopenRecordState). */
function reopenState(s: Snapshot, mission: string, task: string, line: readonly FlowEvent[], st: ReturnType<typeof taskState>, rec: ReopenRecordState, sourceOf: (spec: FlowEvent) => string | null): RepairTaskState {
  if (rec.state === 'not-carried') return { task, state: `the reopen was not carried out: ${rec.why}; ${st.state}`, done: false, notCarried: true };
  if (rec.state === 'requested') {
    const at = st.accepted && st.k >= rec.attempt ? `attempt ${rec.attempt}${st.k > rec.attempt ? ` and the task since (attempt ${st.k})` : ''} accepted: the next pass opens attempt ${st.k + 1} with its issue`
      : `it waits for attempt ${rec.attempt} to be accepted, then opens the next attempt with its issue`;
    return { task, state: `the reopen is not carried out yet: ${at}; ${st.state}`, done: false };
  }
  if (!attemptTaken(s, mission, task, line, rec.attempt)) return { task, state: `the reopen opened attempt ${rec.attempt}, which no seat has taken yet; ${st.state}`, done: false };
  return carriedReopen(task, line, st, [rec.attempt], `reopened at attempt ${rec.attempt}`, '; ', sourceOf);
}

/**
 * 4.4 (final review F3-3, F1-4): a reopen whose issue attempts `carried` carried on their cards: done once an attempt
 * that carried it is accepted, or one that continues it under the same card (a Reviewer's rework), and done for good;
 * an acceptance under another card never counts. Not accepted before another card replaced the attempt's: superseded
 * by what replaced it (neither open nor done).
 */
function carriedReopen(task: string, line: readonly FlowEvent[], st: ReturnType<typeof taskState>, carried: readonly number[], head: string, join: string, sourceOf: (spec: FlowEvent) => string | null): RepairTaskState {
  const cards = carried.map((a) => specOfAttempt(line, a)?.revision ?? null);
  const carries = (k: number): boolean => carried.some((a, i) => k === a || (k > a && (specOfAttempt(line, k)?.revision ?? null) === cards[i]));
  const lastCard = Math.max(...cards.map((c) => c ?? 0));
  const newer = line.filter((e) => e.event === 'spec' && e.revision > lastCard && e.revision > (line.find((x) => x.event === 'rework' && (x.body as { k?: number }).k === Math.max(...carried))?.revision ?? 0));
  const by = newer.map(sourceOf).find((x) => x !== null) ?? (newer.length > 0 ? 'a later plan' : null);
  const credit = creditOf(line, carries);
  if (credit !== null) return { task, state: creditedText(head, join, credit, st, by !== null ? `changed by ${by === 'a later plan' ? 'a plan' : by}` : null), done: true, credited: credit };
  if (by !== null) return { task, state: `${head}; superseded before it was accepted, by ${by}; ${st.state}`, done: false, superseded: by };
  return { task, state: `${head}${join}${st.state}`, done: false };
}

/**
 * 4.4 (final review F3-2): the card attempt k of a task ran under: the latest spec before the attempt's first dispatch
 * (else before the rework that opened it; else before its acceptance). Never the spec written last before the
 * acceptance: a pass that read an earlier attempt's review can commit its acceptance after another process laid a
 * newer card.
 */
function specOfAttempt(line: readonly FlowEvent[], k: number): FlowEvent | undefined {
  const at = (event: string): number | undefined => line.find((e) => e.event === event && (e.body as { k?: number }).k === k)?.revision;
  const anchor = at('dispatched') ?? at('rework') ?? line.find((e) => e.event === 'accepted' && e.key === String(k))?.revision ?? Infinity;
  return line.filter((e) => e.event === 'spec' && e.revision < anchor).at(-1);
}

/**
 * 4.4 (final review F3-1, F1-4): the latest accepted attempt of a task that `carries` (its card carried the repair, or
 * it continues an attempt that did), with its product and risk: once one is accepted the part is done, whatever later
 * attempts do. The current attempt's product is the one the task holds now (a re-bound version); an older attempt's,
 * the one its acceptance recorded. Null: no such acceptance.
 */
function creditOf(line: readonly FlowEvent[], carries: (k: number) => boolean): Credit | null {
  const sel = lineAcceptance(line);
  const accepted = line.filter((e) => e.event === 'accepted').map((e) => e.body as { k: number; product: string; decision?: { escalation?: string; option?: string } }).filter((b) => carries(b.k));
  const last = accepted.sort((a, b) => a.k - b.k).at(-1);
  if (last === undefined) return null;
  if (last.k === sel.k && sel.product !== null) return { attempt: last.k, product: sel.product, risk: currentRiskEscalation(line) };
  return { attempt: last.k, product: last.product, risk: last.decision?.option === 'accept-risk' ? (last.decision.escalation ?? null) : null };
}

/** How a credited part reads: the current state when the credited attempt is the task's current acceptance; else the credited acceptance, and what came since. */
function creditedText(head: string, join: string, c: Credit, st: ReturnType<typeof taskState>, since: string | null): string {
  if (st.accepted && st.k === c.attempt) return `${head}${join}${st.state}`;
  return `${head}${join}accepted at attempt ${c.attempt} (${c.product})${since !== null ? `; later ${since}` : ''}; ${st.state}`;
}

/** The parts of a repair (added, changed, reopened tasks) that are not done, each by what the record establishes. */
function partsOf(added: readonly RepairTaskState[], changed: readonly RepairTaskState[], reopened: readonly RepairTaskState[]): RepairParts {
  const all = ([['added', added], ['changed', changed], ['reopened', reopened]] as const).flatMap(([label, ts]) => ts.filter((t) => !t.done).map((t) => ({ part: `${label} ${t.task}`, t })));
  return {
    open: all.filter((x) => x.t.superseded === undefined && x.t.notRecorded !== true && x.t.notCarried !== true).map((x) => x.part),
    superseded: all.filter((x) => x.t.superseded !== undefined).map((x) => ({ part: x.part, by: x.t.superseded! })),
    notRecorded: all.filter((x) => x.t.notRecorded === true).map((x) => x.part),
    notCarried: all.filter((x) => x.t.notCarried === true).map((x) => x.part),
  };
}

/**
 * 4.4: who gave a spec of `task` that is not the card of repair `repair`: the repair whose change it carries (tagged,
 * or an untagged spec with the card of another repair's amendment of its plan), "a later plan" (a spec of another
 * plan's card), or null (the same plan's card from before the repair: a pass that read the plan before it).
 */
function cardSourceOf(events: readonly FlowEvent[], x: FlowEvent, task: string, repair: string, dplan: string): string | null {
  const b = x.body as { dplan?: string; hash?: string; repair?: string };
  if (b.repair !== undefined) return b.repair === repair ? null : b.repair;
  const by = b.dplan === undefined ? undefined : latestEffectiveOf<{ dplan: string; amendments?: readonly AmendmentEntry[] }>(events, b.dplan)?.amendments
    ?.find((a) => a.repair !== repair && (a.changed ?? []).some((c) => c.id === task && taskCardHash(c) === b.hash));
  if (by !== undefined) return by.repair;
  return b.dplan !== undefined && b.dplan !== dplan ? 'a later plan' : null;
}

/** A task's state as the repair read shows it, from its line: accepted (at which attempt), in work, or given up. */
function taskState(events: readonly FlowEvent[]): { state: string; k: number; accepted: boolean; acceptedRev: number } {
  const sel = lineAcceptance(events);
  if (sel.abandoned) return { state: 'given up', k: sel.k, accepted: false, acceptedRev: 0 };
  if (sel.product === null) return { state: events.some((e) => e.event === 'spec') ? `attempt ${sel.k} in work` : 'not started', k: sel.k, accepted: false, acceptedRev: 0 };
  const rev = events.filter((e) => e.event === 'accepted' && e.key === String(sel.k)).at(-1)?.revision ?? 0;
  return { state: `accepted at attempt ${sel.k} (${sel.product})`, k: sel.k, accepted: true, acceptedRev: rev };
}

export function repairsRead(db: Db, data: DataStore, mission: string): { mission: string; repairs: RepairRead[] } {
  const s = snapshot(db, data, mission);
  const on = (event: string) => s.events.filter((e) => e.line === 'repairs' && e.event === event);
  const decided = new Map(on('decided').map((e) => [e.key, e]));
  const attempts = on('attempt');
  const escalations = s.events.filter((e) => e.line === 'secretary' && e.event === 'escalation').map((e) => e.body as EscalationBody);
  const applied = new Set(s.events.filter((e) => e.line === 'secretary' && e.event === 'applied').map((e) => e.key));
  const out: RepairRead[] = [];
  for (const e of on('repair')) {
    const r = e.body as RepairBody;
    const d = decided.get(r.id);
    const body = d?.body as RepairDecidedBody | undefined;
    let state: RepairRead['state'] = d !== undefined ? 'decided' : attempts.some((a) => a.key.startsWith(`${r.id}#`)) ? 'architect' : 'waiting';
    if (r.about?.kind === 'exploration') {
      const x = r.about.id;
      const answered = s.events.some((a) => a.line === `exploration:${x}` && [ATTEMPTS_AMENDED, ATTEMPT_RERUN, RESNAPSHOTTED].includes(a.event) && ((a.body as { answers?: string; repair?: string }).answers === r.id || (a.body as { repair?: string }).repair === r.id));
      state = answered ? 'answered' : 'exploration';
    }
    const decidedRev = d?.revision ?? Infinity;
    // 4.4 (F13, p6-3): the card this repair gave a changed task, as its amendment recorded it (plan and card hash)
    const amendment = body === undefined ? undefined : latestEffectiveOf<{ dplan: string; amendments?: readonly AmendmentEntry[] }>(s.events, body.dplan)?.amendments?.find((a) => a.repair === r.id);
    // 4.4 (final review F4-1): a part of a filing with items (a new requirement, a repair naming its item) is done only with
    // an accepted product whose fixed review contract binds the items that part carries; else no accepted work is bound to them
    const filingLines = (r.items ?? []).map((i) => `item.${mission}.${i}`);
    const reviewLines = (product: string): readonly string[] | null => { const o = factById(db, 'object.version', product)?.record as ObjectVersionRecord | undefined; return o === undefined ? null : o.reviews.filter((c) => c.review === 'reviewer').flatMap((c) => c.basisLines as readonly string[]); };
    const partItems = (kind: 'add' | 'change' | 'reopen', task: string): readonly string[] => {
      if (filingLines.length === 0) return [];
      if (kind === 'reopen') return (body?.reopen.find((x) => x.task === task)?.items ?? []).filter((l) => filingLines.includes(l));
      const card = (kind === 'add' ? amendment?.tasks : amendment?.changed)?.find((c) => c.id === task);
      return (card?.requirementItems ?? []).filter((l) => filingLines.includes(l));
    };
    const bound = (kind: 'add' | 'change' | 'reopen') => (x: RepairTaskState): RepairTaskState => {
      const items = partItems(kind, x.task);
      if (!x.done || x.credited === undefined || items.length === 0) return x;
      const lines = reviewLines(x.credited.product);
      const missing = lines === null ? [] : items.filter((l) => !lines.includes(l));
      return missing.length === 0 ? x : { task: x.task, state: `${x.state}; its review there was not bound to ${missing.join(', ')}: no accepted work is bound to ${missing.length === 1 ? 'it' : 'them'}`, done: false };
    };
    // 4.4 (final review F3-1): an added task is credited with an accepted attempt under the card this repair added (the
    // first card the task ran under that plan, or a card with its hash, under a later plan too: a plan that drops the
    // task and takes it back with the same card); one under another card never counts for it
    const added = (body?.add ?? []).map((t): RepairTaskState => {
      const line = lineOf(s, t);
      const st = taskState(line);
      const card = amendment?.tasks.find((c) => c.id === t);
      const hash = card === undefined ? null : taskCardHash(card);
      const specs = line.filter((x) => x.event === 'spec');
      const first = specs.find((x) => x.revision > decidedRev);
      const carries = (x: FlowEvent): boolean => { const b = x.body as { dplan?: string; hash?: string; repair?: string }; return (b.repair === undefined || b.repair === r.id) && ((hash !== null && b.hash === hash) || (x === first && b.dplan === body!.dplan)); };
      const credit = creditOf(line, (k) => { const sp = specOfAttempt(line, k); return sp !== undefined && carries(sp); });
      const from = specs.filter((x) => x.revision > decidedRev && carries(x)).at(-1)?.revision ?? decidedRev;
      const replacedBy = specs.filter((x) => x.revision > from && !carries(x)).map((x) => cardSourceOf(s.events, x, t, r.id, body!.dplan) ?? 'a later plan').at(0) ?? null;
      if (credit !== null) return { task: t, state: st.accepted && st.k === credit.attempt ? st.state : `accepted under this repair's card at attempt ${credit.attempt} (${credit.product})${replacedBy !== null ? `; later changed by ${replacedBy === 'a later plan' ? 'a plan' : replacedBy}` : ''}; ${st.state}`, done: true, credited: credit };
      if (replacedBy !== null && first !== undefined) return { task: t, state: `superseded before it was accepted, by ${replacedBy}; ${st.state}`, done: false, superseded: replacedBy };
      return { task: t, state: st.state, done: false };
    }).map(bound('add'));
    const changed = (body?.changed ?? []).map((t): RepairTaskState => {
      const line = lineOf(s, t);
      const st = taskState(line);
      const card = amendment?.changed?.find((c) => c.id === t);
      const hash = card === undefined ? null : taskCardHash(card);
      // the spec that carries this repair: tagged with it, or (a task that had no spec yet) of its plan with its card's hash
      const carries = (x: FlowEvent): boolean => { const b = x.body as { dplan?: string; hash?: string; repair?: string }; return b.repair === r.id || (b.repair === undefined && b.dplan === body!.dplan && hash !== null && b.hash === hash); };
      // p6-r2-3: the card the task is (or was accepted) under is its last spec before the acceptance (the last one, when
      // not accepted); it counts when it postdates the decision and carries this repair, however often the spec was written
      const specs = line.filter((x) => x.event === 'spec');
      // (final review F3-2) an acceptance counts under the card its attempt ran, never the card written last before it
      const carriesAttempt = (k: number): boolean => { const sp = specOfAttempt(line, k); return sp !== undefined && sp.revision > decidedRev && carries(sp); };
      const last = st.accepted ? specOfAttempt(line, st.k) : specs.at(-1);
      const current = last !== undefined && last.revision > decidedRev && carries(last);
      const credit = creditOf(line, carriesAttempt);
      if (credit !== null && st.accepted && st.k === credit.attempt) return { task: t, state: st.state, done: true, credited: credit };
      // 4.4 (v1): what replaced this repair's card, if another card of the task did (a repair's change, or a later plan)
      const carrying = specs.filter((x) => x.revision > decidedRev && carries(x));
      const from = carrying.at(-1)?.revision ?? decidedRev;
      const replacedBy = specs.filter((x) => x.revision > from && !carries(x)).map((x) => cardSourceOf(s.events, x, t, r.id, body!.dplan)).find((by) => by !== null) ?? null;
      // accepted under this repair's own spec at an attempt: that part is done, whatever came later (another repair's or
      // a plan's card, more work on the task); an acceptance under an unrelated spec never counts for it (p6-3)
      if (credit !== null) return { task: t, state: `accepted under this repair's card at attempt ${credit.attempt}${replacedBy !== null ? `; later changed by ${replacedBy === 'a later plan' ? 'a plan' : replacedBy}` : ''}; ${st.state}`, done: true, credited: credit };
      // replaced before any acceptance under it: that card will never run (not open), and its change was never accepted
      // as such (not done); said with what replaced it, so the PM looks there
      if (replacedBy !== null) return { task: t, state: `superseded before it was accepted, by ${replacedBy}; ${st.state}`, done: false, superseded: replacedBy };
      return { task: t, state: carrying.length === 0 ? `${st.state}; no card of this repair's has run yet` : `${st.state}${current ? '' : '; its card changed since this repair'}`, done: false };
    }).map(bound('change'));
    const secretaryEvents = s.events.filter((x) => x.line === 'secretary');
    const repairsEvents = s.events.filter((x) => x.line === 'repairs');
    // 4.4 (F13): the tasks its decision reopens, and one recorded with the decision as not carried out (never in `reopen`)
    const notInDecision = [...new Set(repairsEvents.filter((x) => x.event === REOPEN_NOT_CARRIED && (x.body as { repair?: string }).repair === r.id).map((x) => (x.body as { task: string }).task))]
      .filter((t) => !(body?.reopen ?? []).some((x) => x.task === t));
    const reopened = [...(body?.reopen ?? []), ...notInDecision.map((task) => ({ task, issue: '' }))].map((x): RepairTaskState => {
      const line = lineOf(s, x.task);
      const st = taskState(line);
      // 4.4 (F13): a reopen 4.4 tracks reads from its records: carried out once a seat took the attempt it opened, and
      // done once the task is accepted at that attempt or later (a re-plan after it, or a Reviewer who carries the
      // issue on to a further attempt, does not undo it); requested or pinned: what it waits for; not carried: why
      const rec = reopenRecordState(repairsEvents, r.id, x.task);
      const sourceOf = (spec: FlowEvent): string | null => (body === undefined ? null : cardSourceOf(s.events, spec, x.task, r.id, body.dplan));
      if (rec !== null) return reopenState(s, mission, x.task, line, st, rec, sourceOf);
      // a reopen of a 4.3 decision with no record: only what the record establishes (4.4 schedules nothing for it, so
      // nothing here promises a later step). 4.3 counted it on the task's loop (its marker or its verdict), or an
      // attempt's card carried its issue (repairReopensCarried: its reopen, or a grant that covered it, p6-r2-1)
      // (final review F3-3, F1-3) the attempts whose cards carried its issue: the one its reopen opened (a rework with the
      // reopen, wherever it is on the line), and one a grant on a used-up loop opened for it when a claimed card of that
      // attempt shows the issue. A loop verdict alone (the loop used up, the reopen given up) carried nothing
      const decidedAt = 'attempt' in x ? x.attempt : null;
      const opened = line.filter((y) => y.event === 'rework' && (y.body as { reopen?: { kind?: string; repair?: string } }).reopen?.kind === 'repair' && (y.body as { reopen?: { repair?: string } }).reopen?.repair === r.id).map((y) => (y.body as { k: number }).k);
      const granted = repairReopensCarried(mission, x.task, line, secretaryEvents, repairsEvents, { issue: (repair) => (repair === r.id ? x.issue : null), cards: (k) => attemptDuties(s, data, mission, x.task, k) }).filter((c) => c.repair === r.id).map((c) => c.attempt);
      const carried = [...new Set([...opened, ...granted])].filter((k) => decidedAt === null || k > decidedAt).sort((a, b) => a - b);
      if (carried.length > 0) return carriedReopen(x.task, line, st, carried, `reopened under 4.3 at attempt ${carried.join(', ')}`, ' and ', sourceOf);
      return { task: x.task, state: `decided under 4.3: what became of this reopen is not recorded; ${st.state}`, done: false, notRecorded: true };
    }).map(bound('reopen'));
    const open = escalations.find((q) => q.subject === `repair:${r.id}` && q.source === 'repair-question' && !applied.has(q.id));
    const lineage = repairLineage(mission, r.id);
    const tasks = new Set([...(body?.add ?? []), ...(body?.changed ?? []), ...(body?.reopen ?? []).map((x) => x.task)].map((t) => taskLineage(mission, t)));
    const all = [...added, ...changed, ...reopened];
    // 4.4 (F13): filed again, with --again or (its earlier one's work over) as the same repair
    // 4.4 (G9, p12-8): a new requirement filed again (its earlier filing's work re-planned away) names the same items
    const sameFiling = (x: RepairBody): boolean => x.entry === 'extend' && r.entry === 'extend' && canonicalJson(x.items ?? []) === canonicalJson(r.items ?? []);
    const same = on('repair').find((x) => x.revision < e.revision && (sameRepair(x.body as RepairBody, r) || sameFiling(x.body as RepairBody)))?.key ?? null;
    const filedAgain = r.op !== undefined || same !== null ? { flag: r.op !== undefined, of: same } : null;
    // 4.4 (G4, G5): the open items it names and what its decision gave to which task (the cards it added or changed, its reopens)
    const took = new Map<string, string[]>();
    const give = (task: string, ids: readonly string[] | undefined): void => { for (const id of ids ?? []) took.set(id, [...(took.get(id) ?? []), task]); };
    for (const t of [...(amendment?.tasks ?? []), ...(amendment?.changed ?? [])]) give(t.id, t.openItems);
    for (const x of body?.reopen ?? []) give(x.task, x.openItems);
    const itemIds = [...new Set([...(r.openItems ?? []), ...took.keys()])];
    const closedNow = itemIds.length === 0 ? new Set<string>() : new Set(riskItemsOf(s.events).filter((i) => i.closed !== null).map((i) => i.id));
    const openItems = itemIds.map((id) => ({ id, named: (r.openItems ?? []).includes(id), takenBy: took.get(id) ?? [], closed: closedNow.has(id) }));
    // 4.4 (G9): its items and how its tasks are bound to them, from the decision and the cards it gave (one read)
    if (body === undefined && on(REPAIR_ENDED).some((x) => x.key === r.id)) state = 'ended';
    const lines = (r.items ?? []).map((i) => `item.${mission}.${i}`);
    const withdrawn = new Set(s.events.filter((x) => x.line === 'requirements' && x.event === 'withdrawn').map((x) => (x.body as { line: string }).line));
    const cards = [...(amendment?.tasks ?? []), ...(amendment?.changed ?? [])];
    const unnamed = lines.length < 2 || body === undefined ? [] : [
      ...[...(body.add ?? []), ...(body.changed ?? [])].filter((t) => !(cards.find((c) => c.id === t)?.requirementItems ?? []).some((l) => lines.includes(l))),
      ...(body.reopen ?? []).filter((x) => (x.items ?? []).length === 0).map((x) => x.task),
    ];
    // 4.4: a decision 4.3 recorded (its reopens carry no `tracked`; one with none carries no note); the parts not done,
    // each as the record establishes it (open, superseded, not recorded, not carried out), said instead of "not done"
    const under43 = body !== undefined && body.tracked !== true && (body.reopen.length > 0 || body.note === undefined);
    const parts = body === undefined || r.about?.kind === 'exploration' ? null : partsOf(added, changed, reopened);
    out.push({
      id: r.id, kind: r.kind, words: r.words, text: r.text, about: r.about === null ? null : `${r.about.kind} ${r.about.id}`, state, filedAgain,
      entry: r.entry ?? null,
      items: lines.map((id) => ({ id, state: withdrawn.has(id) ? 'withdrawn' as const : 'in force' as const })),
      checkedBy: s.checked === null || lines.length === 0 ? null : { plan: s.checked.plan, inside: lines.filter((l) => s.checked!.items.has(l)) },
      addedNoItem: lines.length === 0 && (body?.add ?? []).length > 0,
      unnamed: [...new Set(unnamed)],
      // 4.4 (G3, G4): a 4.3 decision has no note; its Architect's accepted hand-back has one
      note: body === undefined ? null : repairNoteOf(body, (step) => noteOfHandBack(taskStatus(db, data, step)?.handBack)),
      under43, parts,
      question: open === undefined ? null : { escalation: open.id, text: open.reasons[0] ?? open.summary },
      added, changed, reopened,
      instructions: s.constraints.filter((c) => isAddressed(c) && (c.scope.repairs ?? []).includes(r.id)).map((c) => c.line),
      dispatches: s.dispatches.filter((x) => x.lineage === lineage).map((x) => ({ dispatch: x.dispatch, seat: x.seat, state: x.state })),
      taskDispatches: s.dispatches.filter((x) => x.rev > decidedRev && tasks.has(x.lineage)).length,
      done: r.about?.kind === 'exploration' || body === undefined ? null : all.length > 0 && all.every((t) => t.done),
      ...(openItems.length > 0 ? { openItems } : {}),
    });
  }
  return { mission, repairs: out };
}

/**
 * 4.4 (v1): the line of a decided repair not done, only what the record establishes: done or superseded (naming
 * what superseded it, so the PM looks there); else "decided" (under 4.3 where it applies) with its parts open,
 * superseded, not carried out and not recorded. Never a bare "not done".
 */
function partsLine(p: RepairParts, under43: boolean): string {
  const by = [...new Set(p.superseded.map((x) => x.by))];
  if (p.open.length + p.notRecorded.length + p.notCarried.length === 0 && by.length > 0) return `decided; done or superseded: see ${by.join(', ')}`;
  const segs = [
    ...(p.open.length > 0 ? [`open: ${p.open.join(', ')}`] : []),
    ...(p.superseded.length > 0 ? [`superseded: ${p.superseded.map((x) => `${x.part} (by ${x.by})`).join(', ')}`] : []),
    ...(p.notCarried.length > 0 ? [`not carried out: ${p.notCarried.join(', ')}`] : []),
    ...(p.notRecorded.length > 0 ? [`not recorded: ${p.notRecorded.join(', ')}`] : []),
  ];
  return `decided${under43 ? ' under 4.3' : ''}; ${segs.length > 0 ? segs.join('; ') : 'it added, changed and reopened no task'}`;
}

/**
 * 4.4 (G9; verification, second run): a filing taken back: a hand-back of its Architect step that came is kept and was
 * not applied; one in flight will be; with none (its step was cancelled before a seat took it), nothing is said of one.
 */
function endedLine(x: RepairRead): string {
  const head = 'ended: every item of it was withdrawn before its amendment was applied';
  if (x.dispatches.some((d) => d.state === 'handed-back')) return `${head} (a hand-back of its Architect step came and is kept; it was not applied)`;
  if (x.dispatches.some((d) => d.state === 'in-flight')) return `${head}; a hand-back of its Architect step that arrives later will be kept and not applied`;
  return head;
}

/** 4.4 (verification, second run): what an undecided repair waits for: its Architect step queued, or in flight. */
function architectLine(x: RepairRead): string {
  return x.dispatches.some((d) => d.state === 'in-flight') ? 'its Architect step is in flight' : 'waiting for its Architect step';
}

export function repairsText(r: ReturnType<typeof repairsRead>): string {
  if (r.repairs.length === 0) return `Mission ${r.mission} has no repair.`;
  const lines = [`Repairs of mission ${r.mission}: ${r.repairs.length}`];
  for (const x of r.repairs) {
    const done = x.done === null ? '' : x.done ? '; done' : '; not done';
    // 4.4 (G9): how the work came in, and what it is bound to
    lines.push(`[${x.id}] ${x.entry === 'extend' ? 'new requirement' : x.kind} (${x.words})${x.about !== null ? `, about ${x.about}` : ''}: "${clip(x.text, 200)}"`);
    lines.push(`    ${x.state === 'ended' ? endedLine(x) : x.state === 'architect' ? architectLine(x) : x.parts !== null && x.done === false ? partsLine(x.parts, x.under43) : `${x.state}${done}`}`);
    // what the plan in effect's check is bound to, read from its contract's sets (a changed plan takes them in)
    const live = x.items.filter((i) => i.state === 'in force').map((i) => i.id);
    const outside = x.checkedBy === null ? [] : live.filter((i) => !x.checkedBy!.inside.includes(i));
    const where = x.checkedBy === null || live.length === 0 ? '' : outside.length === 0 ? `; PM plan ${x.checkedBy.plan} was checked against them` : `; outside the set PM plan ${x.checkedBy.plan} was checked against: ${outside.join(', ')}`;
    if (x.items.length > 0) lines.push(`    ${x.entry === 'extend' ? 'its items' : 'the item it falls short of'}: ${x.items.map((i) => `${i.id}${i.state === 'withdrawn' ? ' (withdrawn)' : ''}`).join(', ')}${where}`);
    if (x.state === 'decided') lines.push("    its work passed its Architect and the mechanical checks, no plan review (D-10)");
    if (x.addedNoItem) lines.push('    it added tasks and names no requirement item (a lead for a spot-check: was it a new requirement? mp pm extend records one)');
    if (x.unnamed.length > 0) lines.push(`    tasks on which its Architect named none of its items (bound to none): ${x.unnamed.join(', ')}`);
    if (x.filedAgain !== null) lines.push(`    filed again${x.filedAgain.flag ? ' with --again' : ''}${x.filedAgain.of !== null ? (x.entry === 'extend' ? `: the same items as new requirement ${x.filedAgain.of} (a task ${x.filedAgain.of} added had left the plan in effect)` : `: the same repair as ${x.filedAgain.of} (words, kind, text and subject)`) : ''}`);
    if (x.question !== null) lines.push(`    its Architect asks the PM (${x.question.escalation}): ${clip(x.question.text, 300)}`);
    if (x.state === 'decided') lines.push(`    the Architect's note: ${x.note === null ? "(not recorded: decided under 4.3, and its Architect's hand-back has none that can be read)" : x.note === '' ? '(none given)' : clip(x.note, 600)}`);
    for (const [label, ts] of [['added', x.added], ['changed', x.changed], ['reopened', x.reopened]] as const) for (const t of ts) lines.push(`    ${label} ${t.task}: ${t.state}`);
    // 4.4 (G4, G5): what its decision gave of the open items it is for (mp read open-items says what takes one now)
    for (const i of x.openItems ?? []) lines.push(`    open item ${i.id}${i.named ? '' : ' (not named on the repair)'}: ${i.takenBy.length > 0 ? `its decision gave it to ${i.takenBy.map((t) => `task ${t}`).join(', ')}` : x.state === 'decided' ? 'given to no task by its decision' : 'not given to a task yet (not decided)'}${i.closed ? '; closed' : '; still open'}`);
    if (x.instructions.length > 0) lines.push(`    instructions addressed to it: ${x.instructions.join(', ')}`);
    lines.push(`    dispatches: ${x.dispatches.map((d) => `${d.dispatch} (${d.seat}, ${d.state})`).join(', ') || 'none'}${x.state === 'decided' ? `; on its tasks since its decision: ${x.taskDispatches}` : ''}`);
  }
  return lines.join('\n');
}
