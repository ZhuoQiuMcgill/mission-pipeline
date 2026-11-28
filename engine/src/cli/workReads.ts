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
import type { MissionId } from '../common/ids.ts';
import { flowEvents, flowMissions, recordsByKind, factById, type Db } from '../memory/index.ts';
import type { DataStore } from '../memory/data.ts';
import { resolveBases, resolveConstraints } from '../memory/domain/constraints.ts';
import { constraintAuthor, type ConstraintBody } from '../flow/requirements.ts';
import { DetailedPlanDoc, amendedPlan, type DetailedPlanDoc as Plan, type RepairBody, type RepairDecidedBody, type StoredDetailedPlan } from '../flow/plandoc.ts';
import type { FlowEvent } from '../flow/ports.ts';
import type { EscalationBody } from '../flow/secretary.ts';
import { addressee, constraintsForTask, isAddressed, planInEffect } from '../seat/cards/dynamic.ts';
import { lineAcceptance, taskLineage } from '../flow/execution.ts';
import { repairLineage } from '../flow/repair.ts';
import { ATTEMPT_RERUN, ATTEMPTS_AMENDED, RESNAPSHOTTED } from '../flow/exploration/machine.ts';

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
  const repairIds = new Set(s.events.filter((e) => e.line === 'repairs' && e.event === 'repair').map((e) => e.key));
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
      const latest = lineOf(s, t.id).filter((e) => e.event === 'review').map((e) => e.body as { task: string; instructions?: Array<{ instruction: string; response: string; reason: string }> }).flatMap((b) => (b.instructions ?? []).filter((i) => i.instruction === c.line).map((i) => ({ task: t.id, review: b.task, response: i.response, reason: i.reason }))).at(-1);
      if (latest !== undefined) answers.push(latest);
    }
    return { ...base, reach: { tasks: tasks.filter((t) => named.has(t.id)).map((t) => t.id), architects: (c.scope.repairs ?? []).filter((r) => repairIds.has(r) && !decided.has(r)) }, answers };
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
  /** Derived: every added task accepted; every changed task accepted after the card the repair gave it; every reopened task accepted at the reopened attempt or later. Null: not a repair of the plan's tasks, or not decided. */
  readonly done: boolean | null;
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
    const changed = (body?.changed ?? []).map((t): RepairTaskState => {
      const line = lineOf(s, t);
      const st = taskState(line);
      // the card the repair gave it: the first spec after the decision
      const spec = line.find((x) => x.event === 'spec' && x.revision > decidedRev);
      return { task: t, state: spec === undefined ? `${st.state}; its changed card has no spec yet` : st.state, done: spec !== undefined && st.accepted && st.acceptedRev > spec.revision };
    });
    const reopened = (body?.reopen ?? []).map((x): RepairTaskState => {
      const line = lineOf(s, x.task);
      const st = taskState(line);
      // the reopened attempt: the rework this repair's reopen started (its card carries the repair's own issue)
      const rw = line.find((y) => y.event === 'rework' && (y.body as { reopen?: { kind?: string; repair?: string } }).reopen?.repair === r.id && (y.body as { reopen?: { kind?: string } }).reopen?.kind === 'repair');
      if (rw === undefined) return { task: x.task, state: `${st.state}; the reopen is not carried out yet`, done: false };
      const j = Number(rw.key);
      // a card given since (a re-plan) is not the card that carried the repair's issue: not shown done
      const respec = line.some((y) => y.event === 'spec' && y.revision > rw.revision);
      return { task: x.task, state: `reopened at attempt ${j}; ${st.state}${respec ? '; its card changed since' : ''}`, done: !respec && st.accepted && st.k >= j && st.acceptedRev > rw.revision };
    });
    const open = escalations.find((q) => q.subject === `repair:${r.id}` && q.source === 'repair-question' && !applied.has(q.id));
    const lineage = repairLineage(mission, r.id);
    const tasks = new Set([...(body?.add ?? []), ...(body?.changed ?? []), ...(body?.reopen ?? []).map((x) => x.task)].map((t) => taskLineage(mission, t)));
    const all = [...added, ...changed, ...reopened];
    out.push({
      id: r.id, kind: r.kind, words: r.words, text: r.text, about: r.about === null ? null : `${r.about.kind} ${r.about.id}`, state,
      note: body?.note ?? null,
      question: open === undefined ? null : { escalation: open.id, text: open.reasons[0] ?? open.summary },
      added, changed, reopened,
      instructions: s.constraints.filter((c) => isAddressed(c) && (c.scope.repairs ?? []).includes(r.id)).map((c) => c.line),
      dispatches: s.dispatches.filter((x) => x.lineage === lineage).map((x) => ({ dispatch: x.dispatch, seat: x.seat, state: x.state })),
      taskDispatches: s.dispatches.filter((x) => x.rev > decidedRev && tasks.has(x.lineage)).length,
      done: r.about?.kind === 'exploration' || body === undefined ? null : all.length > 0 && all.every((t) => t.done),
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
    if (x.question !== null) lines.push(`    its Architect asks the PM (${x.question.escalation}): ${clip(x.question.text, 300)}`);
    if (x.state === 'decided') lines.push(`    the Architect's note: ${x.note === null ? '(not recorded: decided before 4.4)' : x.note === '' ? '(none given)' : clip(x.note, 600)}`);
    for (const [label, ts] of [['added', x.added], ['changed', x.changed], ['reopened', x.reopened]] as const) for (const t of ts) lines.push(`    ${label} ${t.task}: ${t.state}`);
    if (x.instructions.length > 0) lines.push(`    instructions addressed to it: ${x.instructions.join(', ')}`);
    lines.push(`    dispatches: ${x.dispatches.map((d) => `${d.dispatch} (${d.seat}, ${d.state})`).join(', ') || 'none'}${x.state === 'decided' ? `; on its tasks since its decision: ${x.taskDispatches}` : ''}`);
  }
  return lines.join('\n');
}
