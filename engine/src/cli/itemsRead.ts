// 4.4 (the plan's F15, PM design G5): `mp read items <mission>`: the state of each thing the user asked for,
// from the record alone. One line per requirement item and one per repair (under its own words), each with
// its state (not planned, planned, in work, accepted after a passing review, accepted with risk (n open),
// abandoned, delivered, landed; a repair also superseded), its proof and the user's statements that it was checked in the field. A
// statement is shown as the user's, on those words, never as proof. Derived from links that exist: an item's
// tasks are the tasks of the plan in effect whose card links it; a repair's are the tasks it added, changed or
// reopened, credited to it only as `mp read repairs` credits them (cli/workReads.ts, the one function). The
// proof is what the close reads: the evaluator's current label (or "recomputing"), and, for an output the
// current delivery holds, that delivery's own proof result. One snapshot. A later package adds `source`.

import type { MissionId } from '../common/ids.ts';
import type { ProcessContext } from '../process/context.ts';
import { decisionLabels } from '../evaluator/index.ts';
import { currentRiskEscalation, lineAcceptance } from '../flow/execution.ts';
import { REPAIRS_LINE, REQUIREMENTS_LINE, cardChangedBy, repairOfTask, type RepairDecidedBody } from '../flow/plandoc.ts';
import { VERIFIED, VERIFIED_LINE, acceptanceOf, riskCountText, riskRecord, stillOpen, type RiskRecord, type VerifiedBody } from '../flow/riskItems.ts';
import { deliveryDocument } from '../delivery/delivery.ts';
import { currentDelivery, type Db } from '../memory/index.ts';
import { missionEvents, planInEffectOf } from '../process/openItems.ts';
import { repairsRead } from './workReads.ts';

/** superseded (a repair's): every part done or superseded, at least one superseded (mp read repairs says by what). */
export type WorkState = 'not planned' | 'planned' | 'in work' | 'accepted after a passing review' | 'accepted with risk' | 'abandoned' | 'delivered' | 'landed' | 'superseded';

export interface TaskStateView {
  readonly task: string;
  /** superseded: a repair's changed card another card replaced before it was accepted (mp read repairs). */
  readonly state: 'planned' | 'in work' | 'accepted' | 'accepted with risk' | 'abandoned' | 'not in the plan in effect' | 'not done for this repair' | 'superseded';
  readonly product: string | null;
  /** The output's proof as the close reads it (null: not accepted). */
  readonly label: string | null;
  /** A repair's task: what `mp read repairs` says of it. */
  readonly detail?: string;
  /** 4.4 (G9): how the task's work came in, when a filing brought it (absent: with the plan). */
  readonly came?: string;
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
  /** Its acceptances with risk: the distinct items they created or carried that are open (recorded by 4.4), and apart the risk sentences of acceptances made before 4.4 nobody acted on (not recorded). */
  readonly open: number;
  readonly notRecorded: number;
  /** 4.4 (F10): of the open ones, those to verify (kind verify: a standard that could not be verified, or one a person checks). */
  readonly toVerify: number;
  readonly tasks: readonly TaskStateView[];
  /** The proof of its accepted outputs (null: none accepted). */
  readonly proof: string | null;
  /** The user's statements that it was checked in the field and holds (never proof). */
  readonly verified: readonly string[];
  /** 4.4 (G9): a new requirement's item or filing: the filing (R-n) it came with, and the PM plan in effect's check (whether it covers the item). */
  readonly came?: { readonly filing: string; readonly checked: { readonly plan: string; readonly inside: boolean } | null };
  /** 4.4 (G9): a filing's tasks on which its Architect named none of its items (bound to none). */
  readonly unnamed?: readonly string[];
}

type Ev = { revision: number; line: string; event: string; key: string; body: unknown };

/** One task's state, from its line (the mission's task lines read once, by line), with its output's proof. */
function taskStateOf(task: string, lines: ReadonlyMap<string, readonly Ev[]>, inPlan: boolean, proof: (p: string) => string): TaskStateView {
  const line = lines.get(`task:${task}`) ?? [];
  const sel = lineAcceptance(line);
  if (!inPlan) return { task, state: 'not in the plan in effect', product: sel.product, label: sel.product === null ? null : proof(sel.product) };
  if (sel.abandoned) return { task, state: 'abandoned', product: null, label: null };
  if (sel.product !== null) return { task, state: currentRiskEscalation(line) !== null ? 'accepted with risk' : 'accepted', product: sel.product, label: proof(sel.product) };
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

/** The proof of the accepted outputs, summed up (one label, or each with its count). */
function proofOf(tasks: readonly TaskStateView[]): string | null {
  const labels = tasks.filter((t) => t.product !== null && t.label !== null).map((t) => t.label!);
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

/**
 * p10-4: the items the tasks' current acceptances with risk created or carried, still open (distinct), and the 4.3
 * sentences; 4.4 (F10): with the open items of the standards a person checks that the tasks' current acceptances
 * wrote (those of their accepted attempts), counted with the others, and how many of those open are to verify.
 */
function openOn(record: RiskRecord, tasks: readonly TaskStateView[], lines: ReadonlyMap<string, readonly Ev[]>): { open: number; notRecorded: number; toVerify: number } {
  const byId = new Map(record.items.map((i) => [i.id, i]));
  const open = new Set<string>();
  const notRecorded = new Set<string>();
  for (const t of tasks) {
    if (t.state === 'accepted' || t.state === 'accepted with risk') {
      const k = lineAcceptance(lines.get(`task:${t.task}`) ?? []).k;
      for (const i of record.items) if (i.why === 'person' && i.task === t.task && i.attempt === k && i.state === 'open') open.add(i.id);
    }
    if (t.state !== 'accepted with risk') continue;
    const esc = currentRiskEscalation(lines.get(`task:${t.task}`) ?? []);
    const a = esc === null ? undefined : acceptanceOf(record, t.task, esc);
    if (a === undefined) continue;
    // p10-r2-1, v1-4: one classification with every read: open (recorded by 4.4), and apart the sentences before 4.4 nobody acted on
    const s = stillOpen(a, byId);
    for (const id of s.open) open.add(id);
    for (const id of s.notRecorded) notRecorded.add(id);
  }
  return { open: open.size, notRecorded: notRecorded.size, toVerify: [...open].filter((id) => byId.get(id)?.kind === 'verify').length };
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
    // p10-2: the proof as the close reads it: the current label (recomputing while the evaluator is), and the delivery's own result
    const products = [...new Set([...lines.values()].flatMap((l) => { const p = lineAcceptance(l).product; return p === null ? [] : [p]; }))];
    const labels = products.length === 0 ? {} : decisionLabels(db, products);
    const cur = currentDelivery(db, mission as MissionId);
    const dd = cur === null ? null : deliveryDocument(data, cur);
    const delivered = new Set((dd?.entries ?? []).map((e) => e.id));
    const notFullyProven = new Map((dd?.notFullyProven ?? []).map((n) => [n.id, n.reasons]));
    // p10-2 (round 2): both, as the close shows them: the current label, and the delivery's own result beside it
    const proof = (p: string): string => {
      const label = labels[p] ?? 'not labelled yet';
      const nfp = notFullyProven.get(p);
      return nfp !== undefined && delivered.has(p) ? `${label}; delivered as not fully proven on the delivered tree (${nfp.join(', ') || 'no reason recorded'})` : label;
    };
    const landed = cur !== null && landedOf(db, mission, cur.delivery);
    const record = riskRecord(events);
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
    // 4.4 (G9): the filings (one read of repairs): what each added or changed, and the reopens their decisions bound to an item
    const repairs = repairsRead(db, data, mission).repairs;
    const what = (id: string): string => (repairs.find((r) => r.id === id)?.entry === 'extend' ? 'new requirement' : 'repair');
    const cameOf = (task: string): string | undefined => {
      const added = repairOfTask(eff?.amendments, task);
      if (added !== null) return `added by ${what(added)} ${added}`;
      const changed = cardChangedBy(eff?.amendments, task);
      return changed !== null ? `card changed by ${what(changed)} ${changed}` : undefined;
    };
    const reopensOf = new Map<string, Array<{ repair: string; task: string }>>();
    for (const e of events) {
      if (e.line !== REPAIRS_LINE || e.event !== 'decided') continue;
      for (const x of (e.body as RepairDecidedBody).reopen ?? []) for (const l of x.items ?? []) reopensOf.set(l, [...(reopensOf.get(l) ?? []), { repair: e.key, task: x.task }]);
    }
    for (const [line, i] of latest) {
      const id = line.startsWith(prefix) ? line.slice(prefix.length) : line;
      const linked = plan.filter((t) => t.requirementItems.includes(line)).map((t): TaskStateView => { const s = taskStateOf(t.id, lines, true, proof); const came = cameOf(t.id); return came !== undefined ? { ...s, came } : s; });
      // 4.4 (G9): a task a filing's reopen bound to the item, credited as `mp read repairs` credits it
      const reopened = (reopensOf.get(line) ?? []).filter((x) => !linked.some((t) => t.task === x.task)).flatMap((x): TaskStateView[] => {
        const rr = repairs.find((r) => r.id === x.repair)?.reopened.find((t) => t.task === x.task);
        if (rr === undefined) return [];
        const s = taskStateOf(x.task, lines, inPlan.has(x.task), proof);
        const came = `reopened by ${what(x.repair)} ${x.repair}`;
        return [s.state === 'abandoned' || s.state === 'not in the plan in effect' || rr.done ? { ...s, detail: rr.state, came } : { task: x.task, state: 'not done for this repair', product: null, label: null, detail: rr.state, came }];
      });
      const tasks = [...linked, ...reopened];
      const work = i.type !== 'authorization' && i.type !== 'decision';
      // a reopen not carried out yet keeps the item in work (its other tasks' acceptance does not settle it)
      const settled = tasks.filter((t) => t.state !== 'not done for this repair');
      const base = together(settled, delivered, landed);
      const state = i.withdrawn ? 'withdrawn' : !work ? 'not work' : settled.length < tasks.length && base !== 'abandoned' ? 'in work' : base;
      // 4.4 (G9): a new requirement's item says which filing it came with and whether the plan in effect's check covers it
      const filing = repairs.find((r) => r.entry === 'extend' && r.items.some((x) => x.id === line));
      const came = filing === undefined ? {} : { came: { filing: filing.id, checked: filing.checkedBy === null ? null : { plan: filing.checkedBy.plan, inside: filing.checkedBy.inside.includes(line) } } };
      out.push({ kind: 'requirement', id, type: i.type, text: i.text, words: i.words, state, ...openOn(record, tasks, lines), tasks, proof: proofOf(tasks), verified: statements.get(`item:${id}`) ?? [], ...came });
    }
    // p10-3: repairs, with the tasks credited to each exactly as `mp read repairs` credits them (the one function)
    for (const r of repairs) {
      const credited = [...r.added, ...r.changed, ...r.reopened].map((x): TaskStateView => {
        const s = taskStateOf(x.task, lines, inPlan.has(x.task), proof);
        // an acceptance, a delivery or a proof counts for this repair only when the repair read says its work is done;
        // p10-r2-3: a task the plan in effect dropped keeps that state (it is no progress)
        if (s.state === 'abandoned' || s.state === 'not in the plan in effect' || x.done) return { ...s, detail: x.state };
        // 4.4 (v1): a changed card replaced before it was accepted gives the repair no acceptance and no proof
        if (x.superseded !== undefined) return { task: x.task, state: 'superseded', product: null, label: null, detail: x.state };
        return { task: x.task, state: 'not done for this repair', product: null, label: null, detail: x.state };
      });
      const live = credited.filter((t) => t.state !== 'not in the plan in effect');
      const done = live.filter((t) => t.state === 'accepted' || t.state === 'accepted with risk');
      // what is left of the repair's own work: a superseded part is neither in work nor done
      const rest = live.filter((t) => t.state !== 'superseded');
      const state: ItemStateView['state'] = r.about?.startsWith('exploration ') === true ? 'about an exploration'
        : r.state !== 'decided' || live.length === 0 ? 'not planned'
        : r.done === true ? together(live, delivered, landed)
        : rest.some((t) => t.state === 'abandoned') ? 'abandoned'
        : rest.length === done.length ? 'superseded'
        : done.length > 0 || rest.some((t) => (t.detail ?? '').includes('in work')) ? 'in work' : 'planned';
      // 4.4 (G9): a new requirement's filing says so, with its tasks that name none of its items
      const filing = r.entry === 'extend' ? { came: { filing: r.id, checked: null } } : {};
      out.push({ kind: 'repair', id: r.id, type: r.kind, text: r.text, words: r.words, state, ...openOn(record, done, lines), tasks: credited, proof: proofOf(done), verified: statements.get(`repair:${r.id}`) ?? [], ...filing, ...(r.unnamed.length > 0 ? { unnamed: [...r.unnamed] } : {}) });
    }
    return out;
  });
}

/** One line of `mp read items` (and its statements). */
export function itemStateLines(v: ItemStateView): string[] {
  // 4.4 (F10): an accepted item with a standard a person checks still open says so too
  const risk = v.state === 'accepted with risk' || v.tasks.some((t) => t.state === 'accepted with risk') || v.open > 0
    ? ` (${riskCountText(v.open, v.notRecorded, v.toVerify)})`
    : '';
  // 4.4 (G9): a new requirement's filing is named as one
  const head = v.kind === 'requirement' ? `[${v.id}] ${v.type}${v.words !== null ? `, ${v.words}` : ''}` : v.came !== undefined ? `[${v.id}] new requirement, the user's words ${v.words}` : `[${v.id}] repair (${v.type}), the user's words ${v.words}`;
  const tasks = v.tasks.length === 0 ? '' : `; tasks: ${v.tasks.map((t) => `${t.task} ${t.detail !== undefined ? `(${t.detail})` : t.state}${t.came !== undefined ? ` [${t.came}]` : ''}`).join(', ')}`;
  // 4.4 (G9, P-7): how a new requirement's work came in, and whether the plan in effect's check covers its item (read from its contract's sets)
  const came = v.kind !== 'requirement' || v.came === undefined ? [] : [`  came with new requirement ${v.came.filing}: its work passes its Architect and the mechanical checks, no plan review${v.came.checked === null ? '' : v.came.checked.inside ? `; PM plan ${v.came.checked.plan} was checked against it` : `; outside the set PM plan ${v.came.checked.plan} was checked against`}`];
  return [
    `${head}: ${v.state}${risk}${v.proof !== null ? `; proof: ${v.proof}` : ''}${tasks}`,
    `  ${v.text}`,
    ...came,
    ...(v.unnamed !== undefined ? [`  tasks on which its Architect named none of its items (bound to none): ${v.unnamed.join(', ')}`] : []),
    ...v.verified.map((w) => `  the user's statement on ${w}: checked in the field and holds (the user's words, not proof)`),
  ];
}
