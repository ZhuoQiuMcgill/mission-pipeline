// 4.4 (F3, problem P2): materials by need. What a seat handed back reaches the seat that needs it
// next as an optional material: a pointer the seat reads page by page with `mp seat <id> read`, never
// text inlined into the card. Each is built from the accepted hand-back (its structured fields, and
// its report leaf when a leaf can be read), when the card is queued (the flow's ports) and again at
// the claim when the card lacks it (process/pm.ts: a card queued by 4.3 gets its 4.4 materials):
//   constructor-claims   the Reviewer's card: the Constructor's hand-back of the attempt under review,
//                        as claims to check, never evidence (ruling E-4: what a seat is asked to record
//                        reaches the seats that read it; seat/results.ts pointerProblems refuses it as a pointer)
//   previous-review      a rework's Constructor card: the review that judged the attempt it carries on
//   previous-handback    a rework's Constructor card: that attempt's own hand-back
//   feasibility-report   a revision's Architect card and the next feasibility card: the report of the
//                        last feasibility return, carried through the mechanical returns after it
//   paused-handback      4.4 (F4): a resumed Constructor's card: the hand-back with which its attempt
//                        stopped to ask

import type { ArchitectFeasibilityResult } from '../seat/cards/architect.ts';
import { materialPageCount, type MaterialRef } from '../seat/cards/common.ts';
import { constructorQuestions, type ConstructorResult, type ReviewerResult } from '../seat/results.ts';
import type { FlowCtx } from './context.ts';
import { PLAN_LINE } from './plandoc.ts';
import type { AcceptedHandBack } from './ports.ts';

export const CONSTRUCTOR_CLAIMS_MATERIAL = 'constructor-claims';
export const PREVIOUS_REVIEW_MATERIAL = 'previous-review';
export const PREVIOUS_HANDBACK_MATERIAL = 'previous-handback';
export const FEASIBILITY_REPORT_MATERIAL = 'feasibility-report';
export const PAUSED_HANDBACK_MATERIAL = 'paused-handback';

/** What a material is built from: an accepted hand-back and its report's text (null: not readable). */
export interface HandBackSource {
  readonly hb: AcceptedHandBack;
  readonly report: string | null;
}

/** The sync readers of the claim's write (process/pm.ts): a task's accepted hand-back, a leaf's text. */
export interface HandBackReaders {
  handBack(task: string): AcceptedHandBack | null;
  leaf(path: string): string | null;
}

const accepted = (hb: AcceptedHandBack | null | undefined): AcceptedHandBack | null => (hb?.status === 'handed-back' ? hb : null);

/** A task's hand-back as the flow reads it when it queues a card. */
export async function sourceOf(ctx: FlowCtx, task: string): Promise<HandBackSource | null> {
  const hb = accepted((await ctx.ports.scheduler.status(task))?.handBack);
  if (hb === null) return null;
  let report: string | null = null;
  if (hb.report !== null && ctx.ports.ledger.leaf !== undefined) {
    try {
      report = await ctx.ports.ledger.leaf(hb.report);
    } catch {
      report = null;
    }
  }
  return { hb, report };
}

/** A task's hand-back as the claim reads it, in its own write. */
export function sourceAt(r: HandBackReaders, task: string): HandBackSource | null {
  const hb = accepted(r.handBack(task));
  if (hb === null) return null;
  let report: string | null = null;
  try {
    report = hb.report === null ? null : r.leaf(hb.report);
  } catch {
    report = null;
  }
  return { hb, report };
}

/** A material, or the line a card carries in its place when it could not be stored (`notAttached`). */
export type Attached = MaterialRef | { readonly notAttached: string };

/**
 * A material as flow/context.ts `material` makes one (optional, the program's record), from any data
 * store. One that cannot be stored (a report past the data value's limit) never refuses the card that
 * would carry it: the card gets one line instead, naming where the hand-back's report is.
 */
function optional(put: (doc: string) => string, id: string, title: string, doc: string, s: HandBackSource): Attached {
  try {
    return { id, title, ref: put(doc), pages: materialPageCount(doc), mustRead: false, role: 'record' };
  } catch (e) {
    const why = (e as { code?: unknown }).code;
    const where = s.hb.report !== null ? `.mission-pipeline/${s.hb.report}` : `the hand-back of dispatch ${s.hb.dispatch}`;
    return { notAttached: `[${id}] ${title}: could not be attached${typeof why === 'string' ? ` (${why})` : ''}; read the report at ${where}` };
  }
}

/** The id an attached material, or the line in its place, stands for. */
export const attachedId = (x: Attached): string => ('notAttached' in x ? /^\[([^\]]+)\]/.exec(x.notAttached)?.[1] ?? '' : x.id);

/** A card's fields for its optional materials: those stored after `o`'s, and a line for each one that could not be. */
export function attach(xs: ReadonlyArray<Attached | null>, o: { readonly materials?: readonly MaterialRef[] | undefined; readonly materialsNotAttached?: readonly string[] | undefined } = {}): { materials?: MaterialRef[]; materialsNotAttached?: string[] } {
  const materials = [...(o.materials ?? []), ...xs.filter((x): x is MaterialRef => x !== null && !('notAttached' in x))];
  const lines = [...(o.materialsNotAttached ?? []), ...xs.flatMap((x) => (x !== null && 'notAttached' in x ? [x.notAttached] : []))];
  return { ...(materials.length > 0 ? { materials } : {}), ...(lines.length > 0 ? { materialsNotAttached: lines } : {}) };
}

const reportText = (s: HandBackSource): string => (s.report === null ? '(the report could not be read)' : s.report.trim() === '' ? '(empty)' : s.report.trim());
const items = (xs: readonly string[]): string => (xs.length === 0 ? 'None.' : xs.map((x) => `- ${x}`).join('\n'));
/** 4.4 (F4): a hand-back's questions, each with when it must be settled. */
const questions = (r: Partial<ConstructorResult>): string[] => constructorQuestions({ decisions_needed: r.decisions_needed ?? [] }).map((q) => `${q.text} (${q.when})`);

/** The Reviewer's material: the Constructor's hand-back of the attempt under review (its report, `done`, `decisions_needed`). */
export function claimsMaterial(put: (doc: string) => string, s: HandBackSource | null, o: { readonly task: string; readonly attempt: number }): Attached | null {
  const r = (s?.hb.result ?? null) as Partial<ConstructorResult> | null;
  if (s === null || r === null || typeof r.done !== 'string') return null;
  const doc = [
    "# The Constructor's claims: to check, not proof",
    `Task ${o.task}, attempt ${o.attempt}: what its Constructor handed back (dispatch ${s.hb.dispatch}). Check each claim against the candidate and the runs; none of it is evidence for a standard.`,
    '',
    '## What it says it did',
    r.done,
    '',
    '## Questions it raised (decisions_needed)',
    items(questions(r)),
    '',
    '## Its report',
    reportText(s),
    '',
  ].join('\n');
  return optional(put, CONSTRUCTOR_CLAIMS_MATERIAL, `The Constructor's claims: to check, not proof (attempt ${o.attempt})`, doc, s);
}

/** A rework's material: the review that judged the attempt it carries on (its judgments, findings and report). */
export function previousReviewMaterial(put: (doc: string) => string, s: HandBackSource | null, o: { readonly review: string; readonly attempt: number }): Attached | null {
  const r = (s?.hb.result ?? null) as Partial<ReviewerResult> | null;
  if (s === null || r === null || !Array.isArray(r.judgments)) return null;
  const doc = [
    `# The previous review of this task (attempt ${o.attempt})`,
    `Review ${o.review} (dispatch ${s.hb.dispatch}) handed back "${r.verdict ?? '?'}".`,
    '',
    '## Its judgments',
    items(r.judgments.map((j) => `[${j.standard}] ${j.met === 'yes' ? 'met' : j.met === 'no' ? 'not met' : 'unclear'}: ${j.reason}${j.evidence.length > 0 ? ` (${j.evidence.join(', ')})` : ''}`)),
    '',
    '## Its findings',
    items(r.findings ?? []),
    '',
    '## Its report',
    reportText(s),
    '',
  ].join('\n');
  return optional(put, PREVIOUS_REVIEW_MATERIAL, `The previous review's report (attempt ${o.attempt})`, doc, s);
}

/** A rework's material: the earlier attempt's own Constructor hand-back. */
export function previousHandBackMaterial(put: (doc: string) => string, s: HandBackSource | null, o: { readonly attempt: number }): Attached | null {
  const r = (s?.hb.result ?? null) as Partial<ConstructorResult> | null;
  if (s === null || r === null || typeof r.done !== 'string') return null;
  const doc = [
    `# Your earlier hand-back (attempt ${o.attempt})`,
    `Dispatch ${s.hb.dispatch}.`,
    '',
    '## What it says it did',
    r.done,
    '',
    '## Standards it said were not met',
    items((r.unmet_standards ?? []).map((u) => `[${u.standard}] ${u.why}`)),
    '',
    '## Problems it did not fix',
    items(r.unfixed_problems ?? []),
    '',
    '## Questions it raised',
    items(questions(r)),
    '',
    '## Its report',
    reportText(s),
    '',
  ].join('\n');
  return optional(put, PREVIOUS_HANDBACK_MATERIAL, `Your earlier hand-back (attempt ${o.attempt})`, doc, s);
}

/** 4.4 (F4): a resumed attempt's material: the hand-back with which the attempt stopped to ask (pause n). */
export function pausedHandBackMaterial(put: (doc: string) => string, s: HandBackSource | null, o: { readonly attempt: number; readonly pause: number; readonly parked: string }): Attached | null {
  const r = (s?.hb.result ?? null) as Partial<ConstructorResult> | null;
  if (s === null || r === null || typeof r.done !== 'string') return null;
  const doc = [
    `# The hand-back with which this attempt stopped to ask (attempt ${o.attempt}, pause ${o.pause})`,
    `Dispatch ${s.hb.dispatch}. Its edits are commit ${o.parked}, where your worktree starts.`,
    '',
    '## What it says it did so far',
    r.done,
    '',
    '## Its questions',
    items(questions(r)),
    '',
    '## Its report',
    reportText(s),
    '',
  ].join('\n');
  return optional(put, PAUSED_HANDBACK_MATERIAL, `The hand-back that stopped to ask (attempt ${o.attempt}, pause ${o.pause})`, doc, s);
}

/** A revision's material: the feasibility review that returned the plan (its findings, critical path and report). */
export function feasibilityReportMaterial(put: (doc: string) => string, s: HandBackSource | null, o: { readonly review: string; readonly dplan: string }): Attached | null {
  const r = (s?.hb.result ?? null) as Partial<ArchitectFeasibilityResult> | null;
  if (s === null || r === null || !Array.isArray(r.findings)) return null;
  const doc = [
    `# The feasibility review of detailed plan ${o.dplan}`,
    `Review ${o.review} (dispatch ${s.hb.dispatch}) handed back "${r.verdict ?? '?'}".`,
    '',
    '## Its findings',
    items(r.findings.map((f) => `[${f.id}] ${f.severity}, ${f.category}${f.tasks.length > 0 ? ` (${f.tasks.join(', ')})` : ''}: ${f.detail} — suggestion: ${f.suggestion}`)),
    '',
    '## The critical path it found',
    (r.criticalPath ?? []).length > 0 ? (r.criticalPath ?? []).join(' → ') : 'None given.',
    '',
    '## Its report',
    reportText(s),
    '',
  ].join('\n');
  return optional(put, FEASIBILITY_REPORT_MATERIAL, `The previous feasibility report (${o.dplan})`, doc, s);
}

/** The fields of a decomposition attempt the walk reads (flow/planning.ts AttemptBody). */
interface AttemptFields {
  readonly reason: string;
  readonly previous: string | null;
  readonly feasibilityFindings: readonly string[];
}

/** The detailed plan an attempt (plan line event "attempt", key "<pm plan>#<k>") hands back, as flow/planning.ts names it (planAnswersReplan). */
const attemptPlan = (key: string): string => `dplan.${key.slice('pmplan.'.length).replace('#', '.')}`;

/**
 * The feasibility review whose report a revision carries (4.4, F3): the one that returned the plan an
 * attempt revises, or, through mechanical returns, the plan the first revision of the sequence revised.
 * Pure, from the plan line's events (the flow's when it queues, the claim's when it fills a card in).
 */
export function returnedFeasibilityOf(events: ReadonlyArray<{ readonly line: string; readonly event: string; readonly key: string; readonly body: unknown }>, a: AttemptFields | undefined): { readonly review: string; readonly dplan: string } | null {
  const plan = events.filter((e) => e.line === PLAN_LINE);
  const attempts = new Map(plan.filter((e) => e.event === 'attempt').map((e) => [attemptPlan(e.key), e.body as AttemptFields]));
  const seen = new Set<string>();
  for (let at = a; at !== undefined && at.previous !== null && !seen.has(at.previous); at = attempts.get(at.previous)) {
    if (at.feasibilityFindings.length > 0) {
      const previous = at.previous;
      const fb = plan.filter((e) => e.event === 'feasibility' && (e.body as { dplan?: string }).dplan === previous).at(-1)?.body as { task?: string } | undefined;
      return fb?.task === undefined ? null : { review: fb.task, dplan: previous };
    }
    if (at.reason !== 'mechanical') return null;
    seen.add(at.previous);
  }
  return null;
}

/** The attempt that hands back a detailed plan, from the plan line's events (null: none). */
export function attemptOfPlan(events: ReadonlyArray<{ readonly line: string; readonly event: string; readonly key: string; readonly body: unknown }>, dplan: string): AttemptFields | undefined {
  return events.filter((e) => e.line === PLAN_LINE && e.event === 'attempt' && attemptPlan(e.key) === dplan).at(-1)?.body as AttemptFields | undefined;
}

// ---------------------------------------------------------------- the flow's builders (queue time)

const putOf = (ctx: FlowCtx) => (doc: string): string => ctx.ports.ledger.content.put(doc);

export async function constructorClaims(ctx: FlowCtx, o: { readonly constructor: string; readonly task: string; readonly attempt: number }): Promise<Attached | null> {
  return claimsMaterial(putOf(ctx), await sourceOf(ctx, o.constructor), o);
}

export async function previousReviewReport(ctx: FlowCtx, o: { readonly review: string; readonly attempt: number }): Promise<Attached | null> {
  return previousReviewMaterial(putOf(ctx), await sourceOf(ctx, o.review), o);
}

export async function previousHandBack(ctx: FlowCtx, o: { readonly constructor: string; readonly attempt: number }): Promise<Attached | null> {
  return previousHandBackMaterial(putOf(ctx), await sourceOf(ctx, o.constructor), o);
}

export async function pausedHandBack(ctx: FlowCtx, o: { readonly constructor: string; readonly attempt: number; readonly pause: number; readonly parked: string }): Promise<Attached | null> {
  return pausedHandBackMaterial(putOf(ctx), await sourceOf(ctx, o.constructor), o);
}

export async function feasibilityReport(ctx: FlowCtx, o: { readonly review: string; readonly dplan: string }): Promise<Attached | null> {
  return feasibilityReportMaterial(putOf(ctx), await sourceOf(ctx, o.review), o);
}
