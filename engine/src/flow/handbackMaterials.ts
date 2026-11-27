// 4.4 (F3, problem P2): materials by need. What a seat handed back reaches the seat that needs it
// next as an optional material: a pointer the seat reads page by page with `mp seat <id> read`, never
// text inlined into the card. Each is built when its card is queued, from the accepted hand-back
// (its structured fields, and its report leaf when the port reads leaves):
//   constructor-claims   the Reviewer's card: the Constructor's hand-back of the attempt under review,
//                        as claims to check, never evidence (ruling E-4: what a seat is asked to record
//                        reaches the seats that read it; seat/results.ts pointerProblems refuses it as a pointer)
//   previous-review      a rework's Constructor card: the review that judged the attempt it carries on
//   previous-handback    a rework's Constructor card: that attempt's own hand-back
//   feasibility-report   a revision's Architect card and the next feasibility card: the previous review's report

import type { ArchitectFeasibilityResult } from '../seat/cards/architect.ts';
import type { MaterialRef } from '../seat/cards/common.ts';
import type { ConstructorResult, ReviewerResult } from '../seat/results.ts';
import { material, type FlowCtx } from './context.ts';
import type { AcceptedHandBack } from './ports.ts';

export const CONSTRUCTOR_CLAIMS_MATERIAL = 'constructor-claims';
export const PREVIOUS_REVIEW_MATERIAL = 'previous-review';
export const PREVIOUS_HANDBACK_MATERIAL = 'previous-handback';
export const FEASIBILITY_REPORT_MATERIAL = 'feasibility-report';

/** A task's accepted hand-back (its last dispatch's), or null. */
async function handBackOf(ctx: FlowCtx, task: string): Promise<AcceptedHandBack | null> {
  const s = await ctx.ports.scheduler.status(task);
  return s?.handBack?.status === 'handed-back' ? s.handBack : null;
}

/** A hand-back's report, as the seat filed it; a line saying so when it cannot be read. */
async function reportOf(ctx: FlowCtx, hb: AcceptedHandBack): Promise<string> {
  let text: string | null = null;
  if (hb.report !== null && ctx.ports.ledger.leaf !== undefined) {
    try {
      text = await ctx.ports.ledger.leaf(hb.report);
    } catch {
      text = null;
    }
  }
  return text === null ? '(the report could not be read)' : text.trim() === '' ? '(empty)' : text.trim();
}

const items = (xs: readonly string[]): string => (xs.length === 0 ? 'None.' : xs.map((x) => `- ${x}`).join('\n'));

/** The Reviewer's material: the Constructor's hand-back of the attempt under review (its report, `done`, `decisions_needed`). */
export async function constructorClaims(ctx: FlowCtx, o: { readonly constructor: string; readonly task: string; readonly attempt: number }): Promise<MaterialRef | null> {
  const hb = await handBackOf(ctx, o.constructor);
  const r = (hb?.result ?? null) as Partial<ConstructorResult> | null;
  if (hb === null || r === null || typeof r.done !== 'string') return null;
  const doc = [
    "# The Constructor's claims: to check, not proof",
    `Task ${o.task}, attempt ${o.attempt}: what its Constructor handed back (dispatch ${hb.dispatch}). Check each claim against the candidate and the runs; none of it is evidence for a standard.`,
    '',
    '## What it says it did',
    r.done,
    '',
    '## Questions it raised (decisions_needed)',
    items(r.decisions_needed ?? []),
    '',
    '## Its report',
    await reportOf(ctx, hb),
    '',
  ].join('\n');
  return material(ctx, CONSTRUCTOR_CLAIMS_MATERIAL, `The Constructor's claims: to check, not proof (attempt ${o.attempt})`, doc, false, 'record');
}

/** A rework's material: the review that judged the attempt it carries on (its judgments, findings and report). */
export async function previousReviewReport(ctx: FlowCtx, o: { readonly review: string; readonly attempt: number }): Promise<MaterialRef | null> {
  const hb = await handBackOf(ctx, o.review);
  const r = (hb?.result ?? null) as Partial<ReviewerResult> | null;
  if (hb === null || r === null || !Array.isArray(r.judgments)) return null;
  const doc = [
    `# The previous review of this task (attempt ${o.attempt})`,
    `Review ${o.review} (dispatch ${hb.dispatch}) handed back "${r.verdict ?? '?'}".`,
    '',
    '## Its judgments',
    items(r.judgments.map((j) => `[${j.standard}] ${j.met === 'yes' ? 'met' : j.met === 'no' ? 'not met' : 'unclear'}: ${j.reason}${j.evidence.length > 0 ? ` (${j.evidence.join(', ')})` : ''}`)),
    '',
    '## Its findings',
    items(r.findings ?? []),
    '',
    '## Its report',
    await reportOf(ctx, hb),
    '',
  ].join('\n');
  return material(ctx, PREVIOUS_REVIEW_MATERIAL, `The previous review's report (attempt ${o.attempt})`, doc, false, 'record');
}

/** A rework's material: the earlier attempt's own Constructor hand-back. */
export async function previousHandBack(ctx: FlowCtx, o: { readonly constructor: string; readonly attempt: number }): Promise<MaterialRef | null> {
  const hb = await handBackOf(ctx, o.constructor);
  const r = (hb?.result ?? null) as Partial<ConstructorResult> | null;
  if (hb === null || r === null || typeof r.done !== 'string') return null;
  const doc = [
    `# Your earlier hand-back (attempt ${o.attempt})`,
    `Dispatch ${hb.dispatch}.`,
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
    items(r.decisions_needed ?? []),
    '',
    '## Its report',
    await reportOf(ctx, hb),
    '',
  ].join('\n');
  return material(ctx, PREVIOUS_HANDBACK_MATERIAL, `Your earlier hand-back (attempt ${o.attempt})`, doc, false, 'record');
}

/** A revision's material: the feasibility review that returned the previous plan (its findings, critical path and report). */
export async function feasibilityReport(ctx: FlowCtx, o: { readonly review: string; readonly dplan: string }): Promise<MaterialRef | null> {
  const hb = await handBackOf(ctx, o.review);
  const r = (hb?.result ?? null) as Partial<ArchitectFeasibilityResult> | null;
  if (hb === null || r === null || !Array.isArray(r.findings)) return null;
  const doc = [
    `# The feasibility review of detailed plan ${o.dplan}`,
    `Review ${o.review} (dispatch ${hb.dispatch}) handed back "${r.verdict ?? '?'}".`,
    '',
    '## Its findings',
    items(r.findings.map((f) => `[${f.id}] ${f.severity}, ${f.category}${f.tasks.length > 0 ? ` (${f.tasks.join(', ')})` : ''}: ${f.detail} — suggestion: ${f.suggestion}`)),
    '',
    '## The critical path it found',
    (r.criticalPath ?? []).length > 0 ? (r.criticalPath ?? []).join(' → ') : 'None given.',
    '',
    '## Its report',
    await reportOf(ctx, hb),
    '',
  ].join('\n');
  return material(ctx, FEASIBILITY_REPORT_MATERIAL, `The previous feasibility report (${o.dplan})`, doc, false, 'record');
}
