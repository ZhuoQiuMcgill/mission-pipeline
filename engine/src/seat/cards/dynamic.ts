import type { CurrentItem, ConstraintBody, ItemVersionBody } from '../../flow/requirements.ts';
import type { FlowEvent } from '../../flow/ports.ts';
import { elementsOf, repairOfTask, REOPEN_CARRIED, REOPEN_NOT_CARRIED, REOPEN_PINNED, type AmendmentEntry, type DetailedTask, type RepairDecidedBody } from '../../flow/plandoc.ts';
import type { DecisionBody, EscalationBody } from '../../flow/secretary.ts';
import { scopesOverlap } from '../../flow/mechanical.ts';
import { xid } from '../../flow/exploration/definition.ts';
import { canonicalJson } from '../../common/hash.ts';
import { idPart } from '../../common/ids.ts';
import { safeId } from '../../flow/context.ts';
import { materialPageCount, type MaterialRef } from './common.ts';
import type { ReviewContract } from '../../common/records.ts';
import type { DecidingView } from '../../evaluator/semantics.ts';
import { answerText, openItemsOf, type OpenItem } from '../../flow/openItems.ts';
import { ARCHITECT_ANSWER, carriedArchitectAnswer, effectiveAnswer, type ArchitectAnswerBody } from '../../flow/architectAnswers.ts';
import { beforeText, cardItemNames, riskItemsOf, type RiskItem } from '../../flow/riskItems.ts';
import type { EffectiveBody } from '../../flow/planning.ts';

/** The plan in effect, as the flow reads it (`latestEffective`): the mission's last effective detailed plan. */
export function planInEffect(events: readonly FlowEvent[]): EffectiveBody | undefined {
  return events.filter((e) => e.line === 'plan' && e.event === 'effective').at(-1)?.body as EffectiveBody | undefined;
}

/** A review uses its target's fixed contract; production uses the plan in effect. */
export function taskReferencePlan(events: readonly FlowEvent[], contract?: ReviewContract): string | undefined {
  return contract === undefined ? planInEffect(events)?.dplan : contract.reliesOn.find((id) => id.startsWith('dplan.'));
}

/**
 * Instructions are seat context; object constraints retain their proof scope semantics.
 * 4.1.3 (#34, #42): an instruction with no task types whose paths include "**" is meant for the whole
 * mission scope, so it reaches every task there, a task with an empty write scope too (an integration
 * task and its review). A narrower path pattern still needs an overlap with the write scope.
 */
export function constraintsForTask(constraints: readonly ConstraintBody[], task: { readonly kind: string; readonly writeScope: readonly string[] }, mission: string): ConstraintBody[] {
  return constraints.filter((c) => {
    const paths = scopesOverlap(c.scope.paths, task.writeScope).length > 0;
    if (c.scope.mission !== undefined && c.scope.mission !== mission) return false;
    // 4.4 (G3): an addressed instruction reaches only what it names (addressedForTask), never by its scope
    if (isAddressed(c)) return false;
    // a write scope is a set of patterns: overlap decides, never a display string as a concrete path
    return c.kind === 'object' ? (c.scope.taskTypes.length === 0 || c.scope.taskTypes.includes(task.kind)) && paths
      : c.scope.taskTypes.length > 0 ? c.scope.taskTypes.includes(task.kind) || (c.scope.paths.some((p) => p !== '**') && paths) : paths || c.scope.paths.includes('**');
  });
}

/** An exploration's blind executors (4.3): they see one evidence run's steps, never what the exploration expects. */
const BLIND_SEATS: ReadonlySet<string> = new Set(['researcher-reader', 'constructor-experiment']);

/**
 * The project constraints an exploration seat's card shows (9.5), selected as a task card's
 * (constraintsForTask), at queue time (flow/exploration/cards.ts) and again at the claim (refresh.ts).
 * A seat that knows the exploration writes to its product's path and answers to the task type
 * "exploration" (its product's, so an object constraint means for the author what it means for the
 * Crititor and the Stabilizer who review it) and, for an instruction, to its own seat name too. A
 * blind executor writes no product and knows no exploration (`exploration` may be null): only an
 * instruction whose task types name its seat reaches it, not even a mission-wide "**" instruction
 * (which reaches every pathless task card, 4.1.3), so no reading of the exploration's results arrives
 * by default (4.3).
 */
export function constraintsForExploration(constraints: readonly ConstraintBody[], seat: string, mission: string, exploration: string | null): Array<{ id: string; text: string; kind: 'object' | 'instruction' }> {
  const blind = BLIND_SEATS.has(seat);
  const writeScope = blind || exploration === null ? [] : [xid.path(mission, exploration)];
  const lines = new Set([
    ...(blind ? [] : constraintsForTask(constraints, { kind: 'exploration', writeScope }, mission)),
    ...constraintsForTask(constraints, { kind: seat, writeScope }, mission).filter((c) => c.kind === 'instruction' && (!blind || c.scope.taskTypes.includes(seat))),
  ].map((c) => c.line));
  return constraints.filter((c) => lines.has(c.line)).map((c) => ({ id: c.line, text: c.text, kind: c.kind }));
}

/**
 * The constraints an Architect's card shows (4.1.2, item 7): every object constraint and instruction in the
 * mission's scope (a plan covers every path). 4.4 (G3): an addressed instruction is not among them: the
 * Architect's card prints those of the repair in hand in full (addressedForPlanning) and the rest as an index.
 */
export function planningConstraints(constraints: readonly ConstraintBody[], mission: string): Array<{ id: string; text: string; kind: 'object' | 'instruction' }> {
  return constraints.filter((c) => (c.scope.mission === undefined || c.scope.mission === mission) && !isAddressed(c)).map((c) => ({ id: c.line, text: c.text, kind: c.kind }));
}

// ---------------------------------------------------------------- 4.4 (G3): addressed instructions

/** 4.4 (G3): an instruction with an address (tasks or repairs of its mission); it reaches only what it names. */
export function isAddressed(c: Pick<ConstraintBody, 'kind' | 'scope'>): boolean {
  return c.kind === 'instruction' && ((c.scope.tasks?.length ?? 0) > 0 || (c.scope.repairs?.length ?? 0) > 0);
}

/** An instruction on a card's "Instructions for this task" (with its version and, for the Secretary's, who wrote it). */
export interface AddressedRef { readonly id: string; readonly version: string; readonly text: string; readonly by?: 'secretary' }

const addressedRef = (c: ConstraintBody): AddressedRef => ({ id: c.line, version: c.version, text: c.text, ...(c.author !== undefined ? { by: c.author } : {}) });

/**
 * 4.4 (G3): the addressed instructions of a task's cards: those of its mission naming the task, and those
 * naming a repair this work answers (the repair that added the task, changed its card or reopened it).
 */
export function addressedForTask(constraints: readonly ConstraintBody[], mission: string, task: string, repairs: readonly string[] = []): AddressedRef[] {
  return constraints.filter((c) => isAddressed(c) && c.scope.mission === mission && ((c.scope.tasks ?? []).includes(task) || (c.scope.repairs ?? []).some((r) => repairs.includes(r)))).map(addressedRef);
}

/** One index line of an addressed instruction on an Architect's card (F1: id, version, addressee, first line, size). */
export interface AddressedIndexEntry { readonly id: string; readonly version: string; readonly to: string; readonly first: string; readonly bytes: number }

/** Whom an addressed instruction names, in words. */
export function addressee(scope: Pick<ConstraintBody['scope'], 'tasks' | 'repairs'>): string {
  return [(scope.tasks ?? []).length > 0 ? `task${scope.tasks!.length === 1 ? '' : 's'} ${scope.tasks!.join(', ')}` : '', (scope.repairs ?? []).length > 0 ? `repair${scope.repairs!.length === 1 ? '' : 's'} ${scope.repairs!.join(', ')}` : ''].filter((x) => x !== '').join('; ');
}

/**
 * 4.4 (G3, F1): an Architect's card prints in full the addressed instructions of the repair in hand or of
 * the task it is about; the mission's other addressed instructions appear as an index.
 */
export function addressedForPlanning(constraints: readonly ConstraintBody[], mission: string, inHand: { readonly repair?: string; readonly about?: string } = {}): { full: AddressedRef[]; index: AddressedIndexEntry[] } {
  const full: AddressedRef[] = [];
  const index: AddressedIndexEntry[] = [];
  for (const c of constraints) {
    if (!isAddressed(c) || c.scope.mission !== mission) continue;
    if (forRepairArchitect(c, inHand)) full.push(addressedRef(c));
    else index.push({ id: c.line, version: c.version, to: addressee(c.scope), first: line(c.text.split('\n')[0] ?? '', 100), bytes: Buffer.byteLength(c.text, 'utf8') });
  }
  return { full, index };
}

/** 4.4 (G3, F1): whether a repair's Architect card prints an addressed instruction in full: it names the repair, or the task the repair is about. */
export function forRepairArchitect(c: Pick<ConstraintBody, 'kind' | 'scope'>, inHand: { readonly repair?: string; readonly about?: string }): boolean {
  return isAddressed(c) && ((inHand.repair !== undefined && (c.scope.repairs ?? []).includes(inHand.repair)) || (inHand.about !== undefined && (c.scope.tasks ?? []).includes(inHand.about)));
}

/** The card fields of an Architect's addressed instructions (nothing when there are none). */
export function addressedIndexOf(index: readonly AddressedIndexEntry[], full: readonly AddressedRef[] = []): { addressed?: AddressedRef[]; addressedIndex?: AddressedIndexEntry[] } {
  return { ...(full.length > 0 ? { addressed: [...full] } : {}), ...(index.length > 0 ? { addressedIndex: [...index] } : {}) };
}

/**
 * 4.4 (G3, F1): the instructions a plan review's card gets: unaddressed ones whose task types name "pm-plan"
 * (Calibrator ①) or "detailed-plan" (Calibrator ② and the feasibility reviewer), in the mission's scope.
 */
export function planReviewInstructions(constraints: readonly ConstraintBody[], mission: string, of: 'pm-plan' | 'detailed-plan'): Array<{ id: string; text: string; kind: 'instruction' }> {
  return constraints.filter((c) => c.kind === 'instruction' && !isAddressed(c) && (c.scope.mission === undefined || c.scope.mission === mission) && c.scope.taskTypes.includes(of)).map((c) => ({ id: c.line, text: c.text, kind: 'instruction' as const }));
}

/** One event of a task line (or the secretary line), as the flows and the claim read them. */
type LineEvent = { readonly event: string; readonly key: string; readonly body: unknown; readonly revision: number };

/**
 * The reopen requests (keys "reopen:…") an escalation of a used-up rework loop covers: the requests whose loop
 * verdict did not proceed on the attempt it is about (execution.ts reworkAt: a grant gives the attempt after it
 * their issues and instructions). Pure, over the task line's events, so the flow and the claim read the same.
 */
export function coveredReopenKeys(mission: string, task: string, line: readonly LineEvent[], e: { readonly body: EscalationBody; readonly revision: number }): string[] {
  const esc = e.body;
  const facts = esc.facts as { task?: string; attempt?: number; loop?: string } | undefined;
  const reworks = line.filter((x) => x.event === 'rework');
  if (esc.source !== 'loop-exhausted' || esc.subject !== `task:${task}` || facts?.task !== task ||
      facts.loop !== 'rework' || facts.attempt === undefined || facts.attempt > 1 + reworks.length || esc.lineage !== safeId(`task.${mission}.${idPart(task)}`)) return [];
  const attempt = facts.attempt;
  const prefix = `exh.${esc.lineage}.${attempt}`;
  const start = reworks.find((r) => (r.body as { k: number }).k === attempt)?.revision ?? 0;
  const end = reworks.find((r) => (r.body as { k: number }).k === attempt + 1)?.revision ?? Infinity;
  return line.filter((v) => v.event === 'loop-verdict')
    .filter((v) => !(v.body as { proceed: boolean }).proceed && v.key.startsWith('reopen:') && v.revision > start && v.revision < end &&
      (esc.id === safeId(prefix) ? v.revision < e.revision : esc.id === safeId(`${prefix}.${idPart(v.key)}`)))
    .map((v) => v.key);
}

/** 4.4 (F13): where a repair's reopen of one task stands by 4.4's records (flow/execution.ts, the three states above RequestState). */
export type ReopenRecordState =
  /** It waits for the task's attempt `attempt` to be accepted: as decided, or `pinned` again to a later attempt the task moved on to. */
  | { readonly state: 'requested'; readonly attempt: number; readonly pinned: boolean }
  /** The task's attempt `attempt` was opened with the repair's issue on its card (the record at `revision`). */
  | { readonly state: 'carried'; readonly attempt: number; readonly revision: number }
  /** Final: the task was given up, left the plan, or had no accepted work to reopen; the PM was told. */
  | { readonly state: 'not-carried'; readonly attempt: number; readonly why: string };

/**
 * 4.4 (F13): repair `repair`'s reopen of `task` as its records on the repairs line say: its latest record, else its
 * 4.4 decision (requested at the attempt it names), as execution.ts reopenRequests reads them. Null: 4.4 does not
 * track it (a decision with no `tracked` that no record was written for: 4.3's ways, which its cards tell).
 */
export function reopenRecordState(repairs: readonly LineEvent[], repair: string, task: string): ReopenRecordState | null {
  const last = repairs.filter((e) => (e.event === REOPEN_PINNED || e.event === REOPEN_CARRIED || e.event === REOPEN_NOT_CARRIED) &&
    (e.body as { repair?: string }).repair === repair && (e.body as { task?: string }).task === task).at(-1);
  if (last !== undefined) {
    const b = last.body as { attempt: number; why?: string };
    if (last.event === REOPEN_CARRIED) return { state: 'carried', attempt: b.attempt, revision: last.revision };
    if (last.event === REOPEN_NOT_CARRIED) return { state: 'not-carried', attempt: b.attempt, why: b.why ?? '' };
    return { state: 'requested', attempt: b.attempt, pinned: true };
  }
  const d = repairs.find((e) => e.event === 'decided' && (e.body as RepairDecidedBody).repair === repair)?.body as RepairDecidedBody | undefined;
  const x = d?.tracked === true ? d.reopen.find((r) => r.task === task) : undefined;
  return x === undefined ? null : { state: 'requested', attempt: x.attempt, pinned: false };
}

/**
 * 4.4 (G3, F2, F13): each attempt of a task whose card carries a repair's reopen with its issue. A reopen 4.4
 * tracks (reopenRecordState): the attempt its `reopen-carried` record names, whatever card the task has since (a
 * re-plan after it, or a Reviewer who carries the issue on, does not undo it). One 4.3 decided (no record), under
 * the task's current card: the attempt its reopen started (a "rework" with `reopen`), and the attempt a grant on a
 * used-up rework loop started for it (its card carries the covered request's issue: execution.ts reworkAt). The
 * one place the reopens of a repair are read (cards and `mp read repairs`).
 */
export function repairReopensCarried(
  mission: string,
  task: string,
  line: readonly LineEvent[],
  secretary: readonly LineEvent[],
  repairs: readonly LineEvent[],
  // 4.4 (p6-r2-1): a read that must know a card showed the issue: a granted attempt counts only when one of its
  // claimed cards (its Constructor's or its Reviewer's) carries the reopen's issue (absent: the cards are being built)
  check?: { readonly issue: (repair: string) => string | null; readonly cards: (attempt: number) => readonly string[] },
): Array<{ readonly attempt: number; readonly repair: string; readonly revision: number }> {
  const out: Array<{ attempt: number; repair: string; revision: number }> = [];
  // the reopens of this task 4.4 tracks: their records say, never the cards
  const tracked = new Set<string>();
  for (const e of repairs) {
    if (e.event !== 'decided') continue;
    const d = e.body as RepairDecidedBody;
    const s = reopenRecordState(repairs, d.repair, task);
    if (s === null) continue;
    tracked.add(d.repair);
    if (s.state === 'carried') out.push({ attempt: s.attempt, repair: d.repair, revision: s.revision });
  }
  const spec = line.filter((e) => e.event === 'spec').at(-1)?.revision ?? 0;
  const reworks = line.filter((e) => e.event === 'rework' && e.revision > spec);
  for (const e of reworks) {
    const reopen = (e.body as { reopen?: { kind?: string; repair?: string } }).reopen;
    if (reopen?.kind === 'repair' && typeof reopen.repair === 'string' && !tracked.has(reopen.repair)) out.push({ attempt: Number(e.key), repair: reopen.repair, revision: e.revision });
  }
  const granted = new Set(secretary.filter((e) => e.event === 'applied' && (e.body as { what?: { option?: string } }).what?.option === 'grant').map((e) => e.key));
  for (const e of secretary) {
    if (e.event !== 'escalation' || !granted.has(e.key)) continue;
    const attempt = ((e.body as EscalationBody).facts as { attempt?: number } | undefined)?.attempt;
    const next = attempt === undefined ? undefined : reworks.find((r) => Number(r.key) === attempt + 1);
    if (next === undefined) continue;
    for (const key of coveredReopenKeys(mission, task, line, { body: e.body as EscalationBody, revision: e.revision })) {
      const repair = key.slice('reopen:repair:'.length);
      if (!key.startsWith('reopen:repair:') || tracked.has(repair) || out.some((x) => x.attempt === attempt! + 1 && x.repair === repair)) continue;
      if (check !== undefined) {
        const issue = check.issue(repair);
        if (issue === null || !check.cards(attempt! + 1).some((c) => c.includes(issue))) continue;
      }
      out.push({ attempt: attempt! + 1, repair, revision: next.revision });
    }
  }
  return out.sort((a, b) => a.attempt - b.attempt);
}

/**
 * 4.4 (G3, F2): the repairs a task's work answers: the repair that added the task (every attempt), every repair
 * whose amendment changed its card, and every repair whose reopen a card of the task carried at this attempt or
 * before (repairReopensCarried: the reopened attempt and every later one, a granted reopen too). 4.3 showed the
 * adding repair and this attempt's own reopen only.
 */
export function repairsOfTaskWork(mission: string, amendments: readonly AmendmentEntry[] | undefined, task: string, line: readonly LineEvent[], secretary: readonly LineEvent[], repairs: readonly LineEvent[], k: number): string[] {
  const ids: string[] = [];
  const add = (r: string): void => { if (!ids.includes(r)) ids.push(r); };
  const added = repairOfTask(amendments, task);
  if (added !== null) add(added);
  for (const a of amendments ?? []) if ((a.changed ?? []).some((t) => t.id === task)) add(a.repair);
  for (const c of repairReopensCarried(mission, task, line, secretary, repairs)) if (c.attempt <= k) add(c.repair);
  return ids;
}

/**
 * 4.4 (G3): a recorded text of an Architect and the tasks it names. `since` (G1, an Architect's answer): the
 * revision it was recorded at; it reaches a named task's cards under the card that task had then, as an answer
 * belongs to the card it was given under.
 */
export interface ArchitectText { readonly from: string; readonly repair: string | null; readonly tasks: readonly string[]; readonly text: string; readonly since?: number }

/**
 * 4.4 (G3): the Architect's recorded texts: the note of each repair decision, naming the tasks it added,
 * changed or reopened; (G1) an Architect's answer on an escalation that names other tasks of the plan. An
 * answer of a kind carried out as an answer counts once it was carried out (one another decider's answer
 * overrode is not printed); a moot one never does. The asking task gets it as its escalation's answer.
 * A decision 4.3 recorded has no `note`; its Architect wrote one in the accepted hand-back of the step the
 * decision names (`arch`): `handBackNote` reads it (repairNoteOf), and it is printed the same way.
 */
export function architectTexts(events: readonly FlowEvent[], handBackNote?: HandBackNote): ArchitectText[] {
  const out: ArchitectText[] = [];
  let sec: FlowEvent[] | undefined;
  for (const e of events) {
    if (e.line === 'secretary' && e.event === ARCHITECT_ANSWER) {
      const a = e.body as ArchitectAnswerBody;
      if (a.reply !== 'answer' || a.moot !== undefined || (a.tasks ?? []).length === 0) continue;
      sec ??= events.filter((x) => x.line === 'secretary');
      const esc = sec.find((x) => x.event === 'escalation' && x.key === a.escalation)?.body as EscalationBody | undefined;
      // review p11-5: only the escalation's effective answer (the one carried out, or a loop's latest); earlier ones stay its history
      if (esc === undefined || effectiveAnswer(sec, a.escalation, esc.source)?.key !== e.key) continue;
      out.push({ from: `escalation ${a.escalation} (${esc.subject}), the Architect's answer`, repair: null, tasks: [...(a.tasks ?? [])], text: a.text, since: e.revision });
      continue;
    }
    if (e.line !== 'repairs' || e.event !== 'decided') continue;
    const d = e.body as RepairDecidedBody;
    const note = repairNoteOf(d, handBackNote);
    if (note === null || note.trim() === '') continue;
    out.push({ from: `repair ${d.repair}, the Architect's note on its decision`, repair: d.repair, tasks: [...d.add, ...(d.changed ?? []), ...d.reopen.map((x) => x.task)], text: note });
  }
  return out;
}

/**
 * The 4.3 decisions among these repairs (a decision with no `note`) with the Architect step each names: the steps
 * whose accepted hand-back holds the note (the flow reads them before it builds a card: its reads are async).
 */
export function stepsOfNotes43(events: readonly FlowEvent[], repairs: readonly string[]): string[] {
  return events.filter((e) => e.line === 'repairs' && e.event === 'decided' && repairs.includes((e.body as RepairDecidedBody).repair) && (e.body as RepairDecidedBody).note === undefined)
    .map((e) => (e.body as RepairDecidedBody).arch).filter((s): s is string => typeof s === 'string');
}

/** 4.4 (G3, G4): the note in the accepted hand-back of a repair's Architect step (by its step id); null: none, or not readable. */
export type HandBackNote = (step: string) => string | null;

/**
 * 4.4 (G3, G4): the Architect's note of a repair decision: the decision's own (4.4 records one, an empty one too),
 * else, for a decision 4.3 recorded (it has no `note`), the note of the accepted hand-back of its Architect step
 * (`arch`). Null: none recorded or readable; a text that cannot be read is left out, it never fails a read or a claim.
 */
export function repairNoteOf(d: Pick<RepairDecidedBody, 'note' | 'arch'>, handBackNote?: HandBackNote): string | null {
  if (typeof d.note === 'string') return d.note;
  if (handBackNote === undefined || typeof d.arch !== 'string') return null;
  try {
    const note = handBackNote(d.arch);
    return typeof note === 'string' && note.trim() !== '' ? note.trim() : null;
  } catch {
    return null;
  }
}

/** The note of an accepted Architect repair hand-back (its result's `note`), or null. */
export function noteOfHandBack(hb: { readonly status: string; readonly result: unknown } | null | undefined): string | null {
  if (hb?.status !== 'handed-back') return null;
  const note = (hb.result as { note?: unknown } | null)?.note;
  return typeof note === 'string' ? note : null;
}

/**
 * 4.4 (G3): the Architect's texts printed on a task's cards: those naming it; a repair's only while it is among the
 * repairs its work answers; (G1) an answer only while the task keeps the card it had when the answer was recorded.
 */
export function architectNotesFor(events: readonly FlowEvent[], task: string, repairs: readonly string[], handBackNote?: HandBackNote): Array<{ from: string; text: string }> {
  const spec = events.filter((e) => e.line === `task:${task}` && e.event === 'spec').at(-1)?.revision ?? 0;
  // a 4.3 note is read only for the repairs this work answers (one hand-back each)
  const steps = handBackNote === undefined ? null : new Set(stepsOfNotes43(events, repairs));
  const read: HandBackNote | undefined = steps === null ? undefined : (step) => (steps.has(step) ? handBackNote!(step) : null);
  return architectTexts(events, read).filter((t) => t.tasks.includes(task) && (t.repair === null || repairs.includes(t.repair)) && (t.since === undefined || spec < t.since)).map((t) => ({ from: t.from, text: t.text }));
}

/**
 * 4.4 (G3): what was written for a task's work, as its Constructor and Reviewer cards carry it (built alike at
 * queue time and at the claim): the instructions addressed to it or to a repair it answers, the Architect's
 * notes (a 4.3 decision's from its Architect's hand-back, `handBackNote`), and the answers given under its earlier
 * cards. A field with nothing in it is left out.
 */
export function writtenForTask(constraints: readonly ConstraintBody[], events: readonly FlowEvent[], mission: string, task: string, repairs: readonly string[], handBackNote?: HandBackNote): { addressed?: AddressedRef[]; architectNotes?: Array<{ from: string; text: string }>; earlierAnswers?: string[] } {
  const addressed = addressedForTask(constraints, mission, task, repairs);
  const notes = architectNotesFor(events, task, repairs, handBackNote);
  const earlier = earlierTaskAnswers(events, task);
  return { ...(addressed.length > 0 ? { addressed } : {}), ...(notes.length > 0 ? { architectNotes: notes } : {}), ...(earlier.length > 0 ? { earlierAnswers: earlier } : {}) };
}

/**
 * 4.4 (G1, review p11-r2-1): a PM answer its rejection set aside. A rejection names a PM round (`id#r`), and a
 * Secretary retry's decision can carry the same key (`id#n`): it applies to PM answers only.
 */
function rejectedPmAnswer(events: readonly FlowEvent[], a: FlowEvent): boolean {
  return a.event === 'pm-answer' && events.some((r) => r.line === 'secretary' && r.event === 'pm-answer-rejected' && r.key === a.key);
}

/**
 * The answer in effect on one escalation of a task (the user's first, then the PM's latest round, then the
 * Secretary's), when it was carried out as an answer with a text (answerText: its instructions, or else the
 * user's cited words). The current card's decisions and the earlier-decisions list read it alike.
 */
function carriedAnswer(events: readonly FlowEvent[], esc: EscalationBody): DecisionBody | null {
  const applied = events.find((a) => a.line === 'secretary' && a.event === 'applied' && a.key === esc.id);
  const what = applied?.body as { what?: { option?: string }; by?: string } | undefined;
  // 4.4 (G1, review p11-3, p11-5): a used-up loop carried out with a grant: the Architect's latest answer on it reaches
  // the task's next cards as an answer does (the granted attempt's Constructor and Reviewer, at queue time and at the claim)
  if (what?.what?.option === 'grant' && esc.source === 'loop-exhausted') {
    const ruling = effectiveAnswer(events.filter((a) => a.line === 'secretary'), esc.id, esc.source);
    return ruling === null ? null : { escalation: esc.id, by: (what.by ?? 'secretary') as DecisionBody['by'], option: 'answer', classification: 'detail', authorization: null, reason: '', instructions: ruling.text, grantExtra: 0, notice: '', mayMatter: false, architect: ruling.key };
  }
  if (what?.what?.option !== 'answer') return null;
  const answers = events.filter((a) => a.line === 'secretary' && ((a.event === 'user-answer' && a.key === esc.id) || ((a.event === 'decision' || a.event === 'pm-answer') && (a.body as DecisionBody).escalation === esc.id && !rejectedPmAnswer(events, a))));
  const d = (answers.find((a) => a.event === 'user-answer') ?? answers.filter((a) => a.event === 'pm-answer').at(-1) ?? answers.at(-1))?.body as DecisionBody | undefined;
  // 4.4 (G1): the Architect's answer carried out on the asker's decision: its text, read from its reply (the asker stays the decider)
  const architect = carriedArchitectAnswer(events.filter((a) => a.line === 'secretary'), esc.id);
  if (architect !== null && d !== undefined) return { ...d, option: 'answer', instructions: architect.text, architect: architect.key };
  return d?.option === 'answer' && d.by === what.by && answerText(d).trim() !== '' ? d : null;
}

/**
 * 4.4 (G3): the answers carried out on a task's escalations under its earlier cards (raised before its
 * current spec), one line each. 4.3 dropped them at the next spec without a trace.
 */
export function earlierTaskAnswers(events: readonly FlowEvent[], task: string): string[] {
  const spec = events.filter((e) => e.line === `task:${task}` && e.event === 'spec').at(-1)?.revision ?? 0;
  const out: string[] = [];
  for (const e of events) {
    if (e.line !== 'secretary' || e.event !== 'escalation' || e.revision >= spec) continue;
    const esc = e.body as EscalationBody;
    if (esc.subject !== `task:${task}`) continue;
    const d = carriedAnswer(events, esc);
    if (d !== null) out.push(`[${esc.id}] ${d.architect !== undefined ? 'architect' : d.by}: ${line(answerText(d), 200)}`);
  }
  return out;
}

/** Shared selection for queued and dispatched cards, including answers under the current spec only. */
export function taskDecisionQuotes(items: readonly CurrentItem[], events: readonly FlowEvent[], task: Pick<DetailedTask, 'id' | 'requirementItems'>, constraints: readonly ConstraintBody[], referencePlan: string | undefined): string[] {
  const spec = events.filter((e) => e.line === `task:${task.id}` && e.event === 'spec').at(-1);
  const effective = events.find((e) => e.line === 'plan' && e.event === 'effective' && (e.body as { dplan: string }).dplan === referencePlan)?.revision ?? 0;
  const related = new Set(task.requirementItems);
  for (const i of items) if (related.has(i.line) && i.source.kind === 'authorization') related.add(i.source.line);
  for (const c of constraints) related.add(c.line);
  const out: string[] = [];
  for (const i of items) {
    if (i.type !== 'decision' || i.state !== 'valid') continue;
    if (i.source.kind === 'authorization' && !items.some((a) => a.line === (i.source as { line: string }).line && a.type === 'authorization' && a.state === 'valid')) continue;
    // 4.4 (G3): a decision that names its tasks is printed on theirs only
    if (i.tasks !== undefined) {
      if (i.tasks.includes(task.id)) out.push(i.text);
      continue;
    }
    const recorded = events.find((e) => e.line === 'requirements' && e.event === 'item' && (e.body as ItemVersionBody).version === i.version)?.revision ?? 0;
    const after = effective > 0 && recorded > effective;
    const linked = related.has(i.line) || i.source.kind === 'authorization' || constraints.some((c) => c.text.includes(i.line));
    if (linked || after) out.push(`${i.text}${after ? ' (recorded after the plan)' : ''}`);
  }
  for (const e of events) {
    if (e.line !== 'secretary' || e.event !== 'escalation' || e.revision <= (spec?.revision ?? 0)) continue;
    const esc = e.body as EscalationBody;
    if (esc.subject !== `task:${task.id}`) continue;
    // 4.4 (F4, review r2): the text of an answer, one function everywhere (openItems.ts answerText): its instructions, or else the user's cited words
    const d = carriedAnswer(events, esc);
    if (d !== null) out.push(answerText(d));
  }
  return [...new Set(out)];
}

/** 4.4 (G3): whether a decision item is printed for an escalation: one that names its tasks, only about one of them (or when the escalation names it). */
export function decisionConcerns(i: Pick<CurrentItem, 'line' | 'tasks'>, e: Pick<EscalationBody, 'subject' | 'items'>): boolean {
  return i.tasks === undefined || (e.items ?? []).includes(i.line) || i.tasks.some((t) => e.subject === `task:${t}`);
}

export function taskRequirementItems(items: readonly CurrentItem[], task: Pick<DetailedTask, 'requirementItems'>) {
  return task.requirementItems.map((line) => ({ id: line, text: items.find((i) => i.line === line)?.text ?? '(this item is not in force)' }));
}

export function reviewerDecisionQuotes(mission: string, items: readonly CurrentItem[], events: readonly FlowEvent[], task: DetailedTask, constraints: readonly ConstraintBody[], attempt: number, referencePlan: string | undefined) {
  const answers = events.filter((e) => e.line === `task:${task.id}` && e.event === 'reanswer' && e.key.startsWith(`${attempt}:`)).map((e) => (e.body as { decision: string }).decision);
  return [...taskDecisionQuotes(items, events, task, constraintsForTask(constraints, task, mission), referencePlan), ...answers];
}

export function secretaryRoundInputs(esc: EscalationBody, events: readonly FlowEvent[]) {
  const retries = events.filter((e) => e.line === 'secretary' && e.event === 'secretary-retry' && (e.body as { id: string }).id === esc.id);
  const retry = retries.at(-1);
  const body = retry?.body as { task: string; why: string } | undefined;
  return { esc: body === undefined ? esc : { ...esc, task: body.task, reasons: [...esc.reasons, body.why] }, key: retry?.key ?? esc.id, round: retries.length };
}

/** The Secretary's involved items and current facts belong to its builder, at queue and claim. */
export function secretaryInputs(mission: string, e: EscalationBody, items: readonly CurrentItem[], allConstraints: readonly ConstraintBody[], events: readonly FlowEvent[], task: DetailedTask | undefined, grantAvailable: boolean, put: (text: string) => string) {
  // 4.4 (G3): a decision card about a task gets the instructions addressed to that task; addressed ones reach nobody else
  const constraints = task === undefined ? allConstraints.filter((c) => (c.scope.mission === undefined || c.scope.mission === mission) && !isAddressed(c)) : constraintsForTask(allConstraints, task, mission);
  const addressed = task === undefined ? [] : addressedForTask(allConstraints, mission, task.id);
  const auths = items.filter((i) => i.type === 'authorization' && i.state === 'valid');
  const involved = items.filter((i) => (e.items ?? []).includes(i.line) || (i.type === 'decision' && decisionConcerns(i, e)));
  const decisions = involved.filter((i) => i.type === 'decision' && i.state === 'valid' && (i.source.kind !== 'authorization' || auths.some((a) => i.source.kind === 'authorization' && a.line === i.source.line)));
  const selectedItems = involved.filter((i) => i.type !== 'decision' || decisions.includes(i));
  const decisionAuthorities = new Set(decisions.flatMap((i) => i.source.kind === 'authorization' ? [i.source.line] : []));
  const material = (id: string, title: string, text: string, role: MaterialRef['role'], mustRead = true): MaterialRef => ({ id, title, ref: put(text), pages: materialPageCount(text), mustRead, role });
  const request = [`Escalation ${e.id} from ${e.source} on ${e.subject}`, e.summary, e.original ? `Original:\n${e.original}` : '', e.changed ? `Changed:\n${e.changed}` : '', e.reasons.length > 0 ? `Reasons:\n${e.reasons.map((r) => `- ${r}`).join('\n')}` : '', e.facts !== undefined ? `Facts:\n${JSON.stringify(e.facts, null, 2)}` : ''].filter(Boolean).join('\n\n');
  const batches = events.filter((b) => b.line === 'plan' && b.event === 'pm-batch');
  const taskLine = task === undefined ? [] : events.filter((x) => x.line === `task:${task.id}`);
  const openItems = task === undefined ? [] : openItemsOf(events).filter((i) => i.task === task.id);
  // 4.4 (G5): what was left at earlier caps on this task, or that it took, still open (its own block; one line each)
  // (p10-8): what the escalated attempt takes is resolved as its Constructor's and Reviewer's cards resolve it (its
  // card's, and a repair's reopen of this work), beside what originates on the task
  const attempt = (e.facts as { attempt?: unknown } | undefined)?.attempt;
  const current = 1 + taskLine.filter((x) => x.event === 'rework').length;
  const taking = task === undefined ? [] : cardItemNames(events, task, typeof attempt === 'number' ? attempt : current);
  // v1-4: the items recorded by 4.4 only; the sentences of this task's acceptances made before 4.4 nobody acted on, as a count
  const risks = task === undefined ? [] : riskItemsOf(events);
  const left = risks.filter((i) => i.state === 'open' && (i.task === task!.id || taking.includes(i.id)));
  const before = risks.filter((i) => i.state === 'not recorded' && i.task === task!.id).length;
  return {
    // 4.1.2 (item 7): the earlier decisions on the same line, so a ruling is not made again blind
    earlierDecisions: earlierDecisionsOf(e, events),
    // 4.4 (F16): each decision is printed once on the card: in its items, with its id
    decisionQuotes: [],
    constraints: constraints.map((c) => ({ id: c.line, kind: c.kind, text: c.text })),
    ...(addressed.length > 0 ? { addressed } : {}),
    authorizations: auths.map((a) => ({ id: a.line, version: a.version, quote: a.source.kind === 'words' ? a.source.quote : a.text, notifyCondition: a.notifyCondition })),
    items: selectedItems.map((i) => ({ id: i.line, text: i.text })),
    contextItems: [...auths, ...decisions].map((i) => ({ line: i.line, version: i.version, type: decisionAuthorities.has(i.line) ? 'decision-authority' : i.type })),
    grantAvailable,
    materials: [
      material('request', 'The escalated question and its facts', request, 'record'),
      material('authorizations', 'Authorizations in force (verbatim)', auths.map((a) => `[${a.line}] ${a.text}${a.source.kind === 'words' ? ` — "${a.source.quote}"` : ''}`).join('\n') || '(none)', 'authorizations'),
      material('alignment', 'Alignment record (PM batches)', batches.map((b) => `${b.key}: user messages ${(b.body as { userWords: string[] }).userWords.join(', ') || 'none'}`).join('\n') || '(none)', 'record'),
      // 4.4 (F16, P5): a digest that can be read, in place of every event of the task line in full; the
      // constraints are on the card already and are not repeated here
      material('current-facts', 'Current escalation facts (a digest)', secretaryDigest(e, selectedItems, auths, task, taskLine, openItems, left, before), 'record'),
      // 4.4 (F4, review r2): the task's open items in full, with their answers, when it has any
      ...(task === undefined ? [] : [material('task-line', `Task ${task.id}: its card and every event of its line, in full (not must-read)`, canonicalJson({ task, events: taskLine.map((x) => ({ event: x.event, key: x.key, body: x.body })), ...(openItems.length > 0 ? { openItems: openItems.map((i) => ({ id: i.id, attempt: i.attempt, when: i.when, question: i.text, answer: i.answer })) } : {}) }), 'record', false)]),
    ],
  };
}

/** One line of at most `n` characters. */
function line(text: string, n = 160): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length <= n ? t : `${t.slice(0, n - 1)}…`;
}

/** 4.4 (F4, review r2): one line of an open item; when it is cut, it says so and where it is in full. */
function cut(text: string, n: number): string {
  const t = line(text, n);
  return t.length < text.replace(/\s+/g, ' ').trim().length ? `${t} (cut; in full: material task-line)` : t;
}

/**
 * 4.4 (F16): the Secretary's current facts as a digest: the escalation, the selected items by id and one
 * line, the authorizations, the task's goal and standards, one line per event of the task line.
 */
function secretaryDigest(e: EscalationBody, items: readonly CurrentItem[], auths: readonly CurrentItem[], task: DetailedTask | undefined, taskLine: readonly FlowEvent[], open: readonly OpenItem[] = [], left: readonly RiskItem[] = [], before = 0): string {
  const section = (title: string, lines: readonly string[]): string => `${title}:\n${lines.length === 0 ? '(none)' : lines.map((l) => `- ${l}`).join('\n')}`;
  return [
    `Escalation ${e.id} (${e.source}) on ${e.subject}: ${line(e.summary, 300)} (its reasons and facts in full: material request)`,
    section('Items involved', items.map((i) => `[${i.line}] ${i.type}${i.state === 'contested' ? ' (contested)' : ''}: ${line(i.text)}`)),
    section('Authorizations in force', auths.map((a) => `[${a.line}] ${line(a.text)}`)),
    ...(task === undefined ? [] : [
      `Task ${task.id} (${task.kind}): ${line(task.goal, 300)}`,
      section('Its standards', task.standards.map((s) => `[${s.id}] ${line(s.text, 300)}`)),
      // 4.4 (F4; G5): a Constructor's question left open is listed on every card of its task, and its answer on the next ones
      ...(open.length > 0 ? [section('Its open items (questions left open, and their answers)', open.map((i) => `[${i.id}] attempt ${i.attempt}, ${i.when}: ${cut(i.text, 160)}${i.answer === null ? ': open' : `: answered by ${i.answer.by === 'pm' ? 'the PM' : i.answer.by === 'user' ? 'the user' : 'the Secretary'}: ${cut(i.answer.answer, 300)}`}`))] : []),
      // 4.4 (G5): an acceptance with risk leaves these open; a question of design among them is the Architect's or a re-plan's, not an acceptance's
      ...(left.length > 0 ? [section('What is left open on this task (items of earlier acceptances with risk, deferrals, items it took)', left.map((i) => `[${i.id}] ${i.kind}, attempt ${i.attempt}${i.task !== task.id ? ` of task ${i.task}, taken by this task` : ''}${i.carried > 0 ? `, carried ${i.carried}` : ''}: ${line(i.text, 200)}`))] : []),
      // v1-4: the sentences of its acceptances made before 4.4 nobody acted on: a count, never listed as open
      ...(before > 0 ? [`Of this task's acceptances with risk made before 4.4: ${beforeText(before)} (not listed; mp read open-items <mission> --all lists them).`] : []),
      section(`Its line, one event each (in full: material task-line)`, taskLine.map((x) => `${x.event} ${x.key}: ${line(canonicalJson(x.body), 120)}`)),
    ]),
  ].join('\n\n');
}

/**
 * The earlier Secretary decisions on the same subject (a task line, a plan, an exploration, a repair):
 * the decision in effect for each other escalation (the user's answer first), its reason, and whether
 * the owning flow carried it out, or closed it as superseded. Shared by the queue-time builder and the
 * claim-time refresh.
 */
export function earlierDecisionsOf(e: EscalationBody, events: readonly FlowEvent[]): Array<{ escalation: string; source: string; option: string; by: string; reason: string; applied: 'carried out' | 'not carried out yet' | 'closed as superseded' }> {
  const out: Array<{ escalation: string; source: string; option: string; by: string; reason: string; applied: 'carried out' | 'not carried out yet' | 'closed as superseded' }> = [];
  for (const x of events) {
    if (x.line !== 'secretary' || x.event !== 'escalation') continue;
    const esc = x.body as EscalationBody;
    if (esc.id === e.id || esc.subject !== e.subject) continue;
    const answers = events.filter((a) => a.line === 'secretary' && ((a.event === 'user-answer' && a.key === esc.id) || ((a.event === 'decision' || a.event === 'pm-answer') && (a.body as DecisionBody).escalation === esc.id && !rejectedPmAnswer(events, a))));
    const d = (answers.find((a) => a.event === 'user-answer') ?? answers.filter((a) => a.event === 'pm-answer').at(-1) ?? answers.at(-1))?.body as DecisionBody | undefined;
    const applied =events.find((a) => a.line === 'secretary' && a.event === 'applied' && a.key === esc.id)?.body as { what?: { option?: string } } | undefined;
    if (d === undefined && applied?.what?.option !== 'superseded') continue;
    out.push({
      escalation: esc.id,
      source: esc.source,
      option: d?.option ?? '(none)',
      by: d?.by ?? 'nobody',
      reason: d?.reason ?? '',
      applied: applied === undefined ? 'not carried out yet' : applied.what?.option === 'superseded' ? 'closed as superseded' : 'carried out',
    });
  }
  return out;
}

/**
 * Ruling 3 (maintainer, 2026-10-13): whether fast production of `task` under the plan in effect rests on a
 * contested or negated element. The flow's gate (`contestedProduction`) and the dispatch refresh both decide
 * here, each from the same records: the PM plan of the plan in effect, its deciding view, the Calibrator ①
 * outcomes in ledger order, and the detailed plan in effect (its dependency graph).
 */
export function productionDisputed(mission: string, items: readonly CurrentItem[], pm: import('../../flow/plandoc.ts').PmPlanDoc, view: DecidingView | null | undefined, cal1: readonly { readonly judgment: string | null; readonly contested: readonly string[] }[], plan: import('../../flow/plandoc.ts').DetailedPlanDoc, task: DetailedTask): boolean {
  if (view === null || view === undefined) return true;
  const pos = view.positions.find((p) => p.review === 'calibrator-1');
  const negated = pos?.state === 'fail' || pos?.state === 'undecided';
  const failure = negated ? cal1.find((c) => c.judgment === pos.by) : undefined;
  return taskUsesDispute(mission, items, pm, plan, task, negated ? failure?.contested.length ? failure.contested : null : []);
}

/** Null means a negation whose reach cannot be bounded. */
export function taskUsesDispute(mission: string, items: readonly CurrentItem[], pm: import('../../flow/plandoc.ts').PmPlanDoc, plan: import('../../flow/plandoc.ts').DetailedPlanDoc, task: DetailedTask, negated: readonly string[] | null): boolean {
  if (negated === null) return true;
  const contested = new Set(items.filter((i) => i.state === 'contested').map((i) => i.line));
  const seen = new Set<string>();
  const rests = (t: DetailedTask): boolean => {
    if (seen.has(t.id)) return false;
    seen.add(t.id);
    // every element the task covers counts (4.1.2: a task may cover several)
    const covered = elementsOf(t.provenance).flatMap((id) => pm.elements.filter((e) => e.id === id));
    if (t.requirementItems.some((i) => contested.has(i)) || covered.some((element) => element.items.some((i) => contested.has(`item.${mission}.${i}`)) || negated.includes(element.id))) return true;
    return t.dependsOn.some((id) => { const dep = plan.tasks.find((x) => x.id === id); return dep !== undefined && rests(dep); });
  };
  return rests(task);
}
