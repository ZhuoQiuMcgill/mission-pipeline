// 4.4 (the plan's F15, PM design G5): `mp read items <mission>`: the state of each thing the user asked for,
// from the record alone. One line per requirement item and one per repair (under its own words), each with
// its state (not planned, planned, in work, accepted after a passing review, accepted with risk (n open),
// abandoned, delivered, landed), its proof label and the user's statements that it was checked in the field.
// A statement is shown as the user's, on those words, never as proof. Derived from links that exist: an
// item's tasks are the tasks of the plan in effect whose card links it; a repair's are the tasks it added,
// changed or reopened. One snapshot. A later package adds how work came in (`source`).

import type { MissionId } from '../common/ids.ts';
import { currentRiskEscalation, lineAcceptance } from '../flow/execution.ts';
import { REPAIRS_LINE, REQUIREMENTS_LINE, type RepairBody, type RepairDecidedBody } from '../flow/plandoc.ts';
import { VERIFIED, VERIFIED_LINE, type VerifiedBody } from '../flow/riskItems.ts';
import { deliveryDocument } from '../delivery/delivery.ts';
import { currentDelivery, type Db } from '../memory/index.ts';
import type { ProcessContext } from './context.ts';
import { listOpenItemsIn, missionEvents, planInEffectOf } from './openItems.ts';

export type WorkState = 'not planned' | 'planned' | 'in work' | 'accepted after a passing review' | 'accepted with risk' | 'abandoned' | 'delivered' | 'landed';

export interface TaskStateView {
  readonly task: string;
  readonly state: 'planned' | 'in work' | 'accepted' | 'accepted with risk' | 'abandoned' | 'not in the plan in effect';
  readonly product: string | null;
  readonly label: string | null;
}

export interface ItemStateView {
  readonly kind: 'requirement' | 'repair';
  /** The requirement item's id, or the repair's (R-<n>). */
  readonly id: string;
  /** A requirement item's type; a repair's kind. */
  readonly type: string;
  readonly text: string;
  /** The words entry it rests on, when it names one. */
  readonly words: string | null;
  /** withdrawn: a requirement item withdrawn; "not work": an authorization or a decision; about an exploration: a repair of one. */
  readonly state: WorkState | 'withdrawn' | 'not work' | 'about an exploration';
  /** Accepted with risk on some task: its open items (recorded) and the risk sentences of 4.3 acceptances (not recorded). */
  readonly open: number;
  readonly notRecorded: number;
  readonly tasks: readonly TaskStateView[];
  /** The proof labels of its accepted products (null: none accepted). */
  readonly proof: string | null;
  /** The user's statements that it was checked in the field and holds (never proof). */
  readonly verified: readonly string[];
}

type Ev = { revision: number; line: string; event: string; key: string; body: unknown };

/** One task's state, from its line (the mission's task lines read once, by line). */
function taskStateOf(task: string, lines: ReadonlyMap<string, readonly Ev[]>, inPlan: boolean, labels: (p: string) => string | null): TaskStateView {
  const line = lines.get(`task:${task}`) ?? [];
  const sel = lineAcceptance(line);
  if (!inPlan) return { task, state: 'not in the plan in effect', product: sel.product, label: sel.product === null ? null : labels(sel.product) };
  if (sel.abandoned) return { task, state: 'abandoned', product: null, label: null };
  if (sel.product !== null) return { task, state: currentRiskEscalation(line) !== null ? 'accepted with risk' : 'accepted', product: sel.product, label: labels(sel.product) };
  const lastSpec = line.filter((e) => e.event === 'spec').at(-1)?.revision ?? 0;
  const started = line.some((e) => e.event === 'dispatched' && e.revision > lastSpec);
  return { task, state: started ? 'in work' : 'planned', product: null, label: null };
}

/** The state of a set of tasks taken together (none: not planned). */
function together(tasks: readonly TaskStateView[], delivered: ReadonlySet<string>, landed: boolean): WorkState {
  const live = tasks.filter((t) => t.state !== 'not in the plan in effect');
  if (live.length === 0) return 'not planned';
  if (live.some((t) => t.state === 'abandoned')) return 'abandoned';
  if (live.every((t) => t.state === 'accepted' || t.state === 'accepted with risk')) {
    if (live.every((t) => t.product !== null && delivered.has(t.product))) return landed ? 'landed' : 'delivered';
    return live.some((t) => t.state === 'accepted with risk') ? 'accepted with risk' : 'accepted after a passing review';
  }
  return live.some((t) => t.state !== 'planned') ? 'in work' : 'planned';
}

/** The proof labels of the accepted products, summed up ("proven", or each label with its count). */
function proofOf(tasks: readonly TaskStateView[]): string | null {
  const labels = tasks.filter((t) => t.product !== null).map((t) => t.label ?? 'not labelled yet');
  if (labels.length === 0) return null;
  const counts = new Map<string, number>();
  for (const l of labels) counts.set(l, (counts.get(l) ?? 0) + 1);
  return counts.size === 1 ? labels[0]! : [...counts].map(([l, n]) => `${l} (${n})`).join(', ');
}

/** Whether the mission's current delivery landed (its landing intent is done). */
function landedOf(db: Db, mission: string, delivery: string): boolean {
  for (const r of db.stmt("SELECT delivery FROM intents WHERE kind = 'landing' AND state = 'done'").all() as Array<{ delivery: string | null }>) {
    try {
      const d = JSON.parse(r.delivery ?? 'null') as { mission?: string; op?: string } | null;
      if (d?.mission === mission && d.op === delivery) return true;
    } catch {
      /* not a delivery intent */
    }
  }
  return false;
}

/** `mp read items <mission>`: one line per requirement item and one per repair, with its state (one snapshot). */
export function readItems(ctx: ProcessContext, mission: string): ItemStateView[] {
  return ctx.memory.read((db) => {
    const data = ctx.memory.data;
    const events = missionEvents(db, data, mission);
    const lines = new Map<string, Ev[]>();
    for (const e of events) if (e.line.startsWith('task:')) (lines.get(e.line) ?? (lines.set(e.line, []), lines.get(e.line)!)).push(e);
    const eff = planInEffectOf(db, data, events);
    const plan = eff?.plan.tasks ?? [];
    const inPlan = new Set(plan.map((t) => t.id));
    const labelRows = new Map((db.stmt('SELECT target, label FROM lbl_labels').all() as Array<{ target: string; label: string }>).map((r) => [r.target, r.label]));
    const labels = (p: string): string | null => labelRows.get(p) ?? null;
    const cur = currentDelivery(db, mission as MissionId);
    const delivered = new Set(cur === null ? [] : (deliveryDocument(data, cur)?.entries ?? []).map((e) => e.id));
    const landed = cur !== null && landedOf(db, mission, cur.delivery);
    // the open items each task left (recorded), and the 4.3 sentences (not recorded), in the same snapshot
    const { questions, items } = listOpenItemsIn(db, data, mission, events);
    const openOn = (tasks: readonly TaskStateView[]): { open: number; notRecorded: number } => {
      const ids = new Set(tasks.map((t) => t.task));
      const risk = items.filter((i) => i.closed === null && ids.has(i.task));
      return { open: risk.filter((i) => i.recorded).length + questions.filter((q) => q.answer === null && ids.has(q.task)).length, notRecorded: risk.filter((i) => !i.recorded).length };
    };
    const statements = new Map<string, string[]>();
    for (const e of events) {
      if (e.line !== VERIFIED_LINE || e.event !== VERIFIED) continue;
      const v = e.body as VerifiedBody;
      statements.set(v.subject, [...(statements.get(v.subject) ?? []), v.words]);
    }
    const out: ItemStateView[] = [];
    // requirement items: the latest version of each line, in the order they were first recorded
    const latest = new Map<string, { type: string; text: string; words: string | null; withdrawn: boolean }>();
    for (const e of events) {
      if (e.line !== REQUIREMENTS_LINE) continue;
      const b = e.body as { line?: string; type?: string; text?: string; source?: { kind?: string; words?: string } };
      if (e.event === 'item' && typeof b.line === 'string') latest.set(b.line, { type: String(b.type ?? ''), text: String(b.text ?? ''), words: b.source?.kind === 'words' ? (b.source.words ?? null) : null, withdrawn: false });
      else if (e.event === 'withdrawn' && latest.has(e.key)) latest.set(e.key, { ...latest.get(e.key)!, withdrawn: true });
    }
    const prefix = `item.${mission}.`;
    for (const [line, i] of latest) {
      const id = line.startsWith(prefix) ? line.slice(prefix.length) : line;
      const tasks = plan.filter((t) => t.requirementItems.includes(line)).map((t) => taskStateOf(t.id, lines, true, labels));
      const work = i.type !== 'authorization' && i.type !== 'decision';
      const state = i.withdrawn ? 'withdrawn' : !work ? 'not work' : together(tasks, delivered, landed);
      out.push({ kind: 'requirement', id, type: i.type, text: i.text, words: i.words, state, ...openOn(tasks), tasks, proof: proofOf(tasks), verified: statements.get(`item:${id}`) ?? [] });
    }
    // repairs: the tasks each one added, changed or reopened
    const decided = new Map(events.filter((e) => e.line === REPAIRS_LINE && e.event === 'decided').map((e) => [e.key, e.body as RepairDecidedBody]));
    for (const e of events) {
      if (e.line !== REPAIRS_LINE || e.event !== 'repair') continue;
      const r = e.body as RepairBody;
      const d = decided.get(r.id);
      const ids = d === undefined ? [] : [...new Set([...d.add, ...(d.changed ?? []), ...d.reopen.map((x) => x.task)])];
      const tasks = ids.map((t) => {
        const s = taskStateOf(t, lines, inPlan.has(t), labels);
        // a reopened task counts as this repair's work once an attempt after the one it reopened is accepted
        const reopened = d?.reopen.find((x) => x.task === t);
        if (reopened === undefined || (s.state !== 'accepted' && s.state !== 'accepted with risk')) return s;
        return lineAcceptance(lines.get(`task:${t}`) ?? []).k > reopened.attempt ? s : { ...s, state: 'planned' as const, product: null, label: null };
      });
      const state = r.about?.kind === 'exploration' ? 'about an exploration' : together(tasks, delivered, landed);
      out.push({ kind: 'repair', id: r.id, type: r.kind, text: r.text, words: r.words, state, ...openOn(tasks), tasks, proof: proofOf(tasks), verified: statements.get(`repair:${r.id}`) ?? [] });
    }
    return out;
  });
}

/** One line of `mp read items` (and its statements). */
export function itemStateLines(v: ItemStateView): string[] {
  const risk = v.state === 'accepted with risk' || v.tasks.some((t) => t.state === 'accepted with risk')
    ? ` (${v.open} open${v.notRecorded > 0 ? `, ${v.notRecorded} risk sentence(s) of 4.3 acceptances: what became of them is not recorded` : ''})`
    : '';
  const head = v.kind === 'requirement' ? `[${v.id}] ${v.type}${v.words !== null ? `, ${v.words}` : ''}` : `[${v.id}] repair (${v.type}), the user's words ${v.words}`;
  const tasks = v.tasks.length === 0 ? '' : `; tasks: ${v.tasks.map((t) => `${t.task} ${t.state}`).join(', ')}`;
  return [
    `${head}: ${v.state}${risk}${v.proof !== null ? `; proof: ${v.proof}` : ''}${tasks}`,
    `  ${v.text}`,
    ...v.verified.map((w) => `  the user's statement on ${w}: checked in the field and holds (the user's words, not proof)`),
  ];
}
