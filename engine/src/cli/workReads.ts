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
import { constraintAuthor, type ConstraintBody } from '../flow/requirements.ts';
import { DetailedPlanDoc, amendedPlan, latestEffectiveOf, REOPEN_NOT_CARRIED, taskCardHash, type AmendmentEntry, type DetailedPlanDoc as Plan, type RepairBody, type RepairDecidedBody, type StoredDetailedPlan } from '../flow/plandoc.ts';
import type { FlowEvent } from '../flow/ports.ts';
import type { EscalationBody } from '../flow/secretary.ts';
import { addressee, constraintsForTask, forRepairArchitect, isAddressed, planInEffect, repairReopensCarried, reopenRecordState, type ReopenRecordState } from '../seat/cards/dynamic.ts';
import { lineAcceptance, taskLineage } from '../flow/execution.ts';
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
  return { events, constraints, plan, dispatches };
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

export interface RepairTaskState { readonly task: string; readonly state: string; readonly done: boolean }

export interface RepairRead {
  readonly id: string;
  readonly kind: string;
  readonly words: string;
  readonly text: string;
  readonly about: string | null;
  readonly state: 'waiting' | 'architect' | 'decided' | 'exploration' | 'answered';
  /**
   * 4.4 (F13): filed again: with `--again` (`flag`, its operation recorded with it), and the same repair (words, kind,
   * text and subject) filed before it (`of`, null: none). Null: neither.
   */
  readonly filedAgain: { readonly flag: boolean; readonly of: string | null } | null;
  /** The Architect's note on its decision ("" when it gave none); null: not decided, or decided before 4.4 (not recorded). */
  readonly note: string | null;
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
   * Derived: every added task accepted; every changed task accepted after the card the repair gave it; every reopened
   * task accepted at the attempt its reopen opened or later (4.4: by its `reopen-carried` record, once a seat took that
   * attempt; a reopen waiting or not carried out is not done; 4.3: the accepted attempt's card carried the issue).
   * Null: not a repair of the plan's tasks, or not decided.
   */
  readonly done: boolean | null;
  /**
   * 4.4 (G4, G5): the open items the repair names (`--open-items`) or its decision gave to a task: the tasks of its
   * decision that took each (none: it stays open, given to no task) and whether it is closed now. Absent: none.
   */
  readonly openItems?: ReadonlyArray<{ readonly id: string; readonly named: boolean; readonly takenBy: readonly string[]; readonly closed: boolean }>;
}

/** The same repair (flow/repair.ts recordRepair): the same words, kind, text and subject (4.4: and the open items it names). */
const sameRepair = (a: RepairBody, b: RepairBody): boolean => a.words === b.words && a.kind === b.kind && a.text === b.text && canonicalJson(a.about) === canonicalJson(b.about) && canonicalJson(a.openItems ?? []) === canonicalJson(b.openItems ?? []);

/** Whether a seat took attempt k of a task (as execution.ts attemptTaken): it was reviewed, or a dispatch of its Constructor or Reviewer exists. */
function attemptTaken(s: Snapshot, mission: string, task: string, line: readonly FlowEvent[], k: number): boolean {
  if (line.some((e) => e.event === 'review' && (e.body as { k?: number }).k === k)) return true;
  const con = safeId(`con.${mission}.${idPart(task)}.${k}`);
  const rev = safeId(`rev.${mission}.${idPart(task)}.${k}`);
  return s.dispatches.some((d) => d.task === con || d.task === rev || d.task.startsWith(`${rev}.r`));
}

/** 4.4 (F13): a reopen 4.4 tracks as the read of repairs says it, from its records (seat/cards/dynamic.ts reopenRecordState). */
function reopenState(s: Snapshot, mission: string, task: string, line: readonly FlowEvent[], st: ReturnType<typeof taskState>, rec: ReopenRecordState): RepairTaskState {
  if (rec.state === 'not-carried') return { task, state: `the reopen was not carried out: ${rec.why}; ${st.state}`, done: false };
  if (rec.state === 'requested') {
    const at = st.accepted && st.k >= rec.attempt ? `attempt ${rec.attempt}${st.k > rec.attempt ? ` and the task since (attempt ${st.k})` : ''} accepted: the next pass opens attempt ${st.k + 1} with its issue`
      : `it waits for attempt ${rec.attempt} to be accepted, then opens the next attempt with its issue`;
    return { task, state: `the reopen is not carried out yet: ${at}; ${st.state}`, done: false };
  }
  if (!attemptTaken(s, mission, task, line, rec.attempt)) return { task, state: `the reopen opened attempt ${rec.attempt}, which no seat has taken yet; ${st.state}`, done: false };
  return { task, state: `reopened at attempt ${rec.attempt}; ${st.state}`, done: st.accepted && st.k >= rec.attempt };
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
    const added = (body?.add ?? []).map((t): RepairTaskState => { const st = taskState(lineOf(s, t)); return { task: t, state: st.state, done: st.accepted }; });
    // 4.4 (F13, p6-3): the card this repair gave a changed task, as its amendment recorded it (plan and card hash)
    const amendment = body === undefined ? undefined : latestEffectiveOf<{ dplan: string; amendments?: readonly AmendmentEntry[] }>(s.events, body.dplan)?.amendments?.find((a) => a.repair === r.id);
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
      const last = (st.accepted ? specs.filter((x) => x.revision < st.acceptedRev) : specs).at(-1);
      const current = last !== undefined && last.revision > decidedRev && carries(last);
      const ever = specs.some((x) => x.revision > decidedRev && carries(x));
      return { task: t, state: !ever ? `${st.state}; no card of this repair's has run yet` : `${st.state}${current ? '' : '; its card changed since this repair'}`, done: st.accepted && current };
    });
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
      if (rec !== null) return reopenState(s, mission, x.task, line, st, rec);
      // a 4.3 decision (no record): the attempts whose card carried this repair's own issue (its reopen, or a grant that
      // covered it, p6-r2-1: when one of that attempt's claimed cards shows the issue), under the current card (p6-4)
      const carried = repairReopensCarried(mission, x.task, line, secretaryEvents, repairsEvents, { issue: (repair) => (repair === r.id ? x.issue : null), cards: (k) => attemptDuties(s, data, mission, x.task, k) }).filter((c) => c.repair === r.id);
      if (carried.length === 0) {
        const before = line.some((y) => y.event === 'rework' && (y.body as { reopen?: { kind?: string; repair?: string } }).reopen?.repair === r.id);
        return { task: x.task, state: `${st.state}; ${before ? 'its card changed since the reopen' : 'the reopen is not carried out yet'}`, done: false };
      }
      const at = carried.find((c) => c.attempt === st.k);
      const done = st.accepted && at !== undefined && st.acceptedRev > at.revision;
      return { task: x.task, state: `reopened at attempt ${carried.map((c) => c.attempt).join(', ')}; ${st.state}${st.accepted && !done ? "; the accepted attempt's card did not carry this repair's issue" : ''}`, done };
    });
    const open = escalations.find((q) => q.subject === `repair:${r.id}` && q.source === 'repair-question' && !applied.has(q.id));
    const lineage = repairLineage(mission, r.id);
    const tasks = new Set([...(body?.add ?? []), ...(body?.changed ?? []), ...(body?.reopen ?? []).map((x) => x.task)].map((t) => taskLineage(mission, t)));
    const all = [...added, ...changed, ...reopened];
    // 4.4 (F13): filed again, with --again or (its earlier one's work over) as the same repair
    const same = on('repair').find((x) => x.revision < e.revision && sameRepair(x.body as RepairBody, r))?.key ?? null;
    const filedAgain = r.op !== undefined || same !== null ? { flag: r.op !== undefined, of: same } : null;
    // 4.4 (G4, G5): the open items it names and what its decision gave to which task (the cards it added or changed, its reopens)
    const took = new Map<string, string[]>();
    const give = (task: string, ids: readonly string[] | undefined): void => { for (const id of ids ?? []) took.set(id, [...(took.get(id) ?? []), task]); };
    for (const t of [...(amendment?.tasks ?? []), ...(amendment?.changed ?? [])]) give(t.id, t.openItems);
    for (const x of body?.reopen ?? []) give(x.task, x.openItems);
    const itemIds = [...new Set([...(r.openItems ?? []), ...took.keys()])];
    const closedNow = itemIds.length === 0 ? new Set<string>() : new Set(riskItemsOf(s.events).filter((i) => i.closed !== null).map((i) => i.id));
    const openItems = itemIds.map((id) => ({ id, named: (r.openItems ?? []).includes(id), takenBy: took.get(id) ?? [], closed: closedNow.has(id) }));
    out.push({
      id: r.id, kind: r.kind, words: r.words, text: r.text, about: r.about === null ? null : `${r.about.kind} ${r.about.id}`, state, filedAgain,
      note: body?.note ?? null,
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

export function repairsText(r: ReturnType<typeof repairsRead>): string {
  if (r.repairs.length === 0) return `Mission ${r.mission} has no repair.`;
  const lines = [`Repairs of mission ${r.mission}: ${r.repairs.length}`];
  for (const x of r.repairs) {
    const done = x.done === null ? '' : x.done ? '; done' : '; not done';
    lines.push(`[${x.id}] ${x.kind} (${x.words})${x.about !== null ? `, about ${x.about}` : ''}: "${clip(x.text, 200)}"`);
    lines.push(`    ${x.state}${done}`);
    if (x.filedAgain !== null) lines.push(`    filed again${x.filedAgain.flag ? ' with --again' : ''}${x.filedAgain.of !== null ? `: the same repair as ${x.filedAgain.of} (words, kind, text and subject)` : ''}`);
    if (x.question !== null) lines.push(`    its Architect asks the PM (${x.question.escalation}): ${clip(x.question.text, 300)}`);
    if (x.state === 'decided') lines.push(`    the Architect's note: ${x.note === null ? '(not recorded: decided before 4.4)' : x.note === '' ? '(none given)' : clip(x.note, 600)}`);
    for (const [label, ts] of [['added', x.added], ['changed', x.changed], ['reopened', x.reopened]] as const) for (const t of ts) lines.push(`    ${label} ${t.task}: ${t.state}`);
    // 4.4 (G4, G5): what became of the open items it is for
    for (const i of x.openItems ?? []) lines.push(`    open item ${i.id}${i.named ? '' : ' (not named on the repair)'}: ${i.takenBy.length > 0 ? `taken by ${i.takenBy.map((t) => `task ${t}`).join(', ')}` : x.state === 'decided' ? 'given to no task by its decision' : 'not given to a task yet (not decided)'}${i.closed ? '; closed' : '; still open'}`);
    if (x.instructions.length > 0) lines.push(`    instructions addressed to it: ${x.instructions.join(', ')}`);
    lines.push(`    dispatches: ${x.dispatches.map((d) => `${d.dispatch} (${d.seat}, ${d.state})`).join(', ') || 'none'}${x.state === 'decided' ? `; on its tasks since its decision: ${x.taskDispatches}` : ''}`);
  }
  return lines.join('\n');
}
