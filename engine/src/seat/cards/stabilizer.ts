// The Stabilizer seat (design 4.1 §6.3, U-6, U-7): after every attack round (once the author
// disposed of its findings, or at once when it left the author nothing to answer), a new instance
// judges the round for drift. Finding fault never ends: the Stabilizer decides which findings bind
// the author, and whether the work still answers the question it was given.
//
// Card: the exploration definition with the maintainer's fuzzy acceptance goal verbatim, the
// question, the attack scope and the decision it serves; the round's findings with the author's
// dispositions; the first and the current version of the product (must-read materials); the
// earlier rounds' judgments and the rulings.
//
// Hand-back: per finding a verdict (in-scope: a real problem against the definition, the author
// must answer it; shifts-direction: the finding, or the fix the author accepted, would change the
// question, the goal or the direction, or contradicts the maintainer's words; out-of-scope: a
// nitpick outside the attack scope) with its severity as the Stabilizer judges it; and the round
// verdict (on-track, or drifting: the product moved away from the definition across rounds).
// Direction findings and drift name the question for the Secretary.
//
// Records: the judgment of the review position "crititor + stabilizer" (review "crititor") on the
// round's attacked version (4.1 §6.3): refuted while a finding judged in scope and fatal or
// serious is unresolved on it; pending ("undecided") while a direction question waits for a
// ruling (this round's, or one still pending from before: an author's question, an escalated
// finding, a drift); passed otherwise (naming the negation it revokes). A finding judged out of
// scope or shifting direction never refutes the version.

import { z } from 'zod';
import type { JudgmentId, ObjectVersionId } from '../../common/ids.ts';
import type { JudgmentRecord, ListRef, Verdict } from '../../common/records.ts';
import { validateRecord } from '../../common/validate.ts';
import { EMPTY_LIST } from './calibrator.ts';
import { Binding, Material, commonCardFields, list, renderCommon, renderMaterials, unreadMustRead } from './common.ts';
import { ExplorationRef, PriorFinding, SEVERITIES, isBlocking, renderExploration, renderPriorFindings, type PriorFindingT } from './crititor.ts';
import { registerSeatCard, type CardRecordContext, type SeatCardEntry } from './registry.ts';

export const STABILIZER_VERDICTS = ['in-scope', 'shifts-direction', 'out-of-scope'] as const;
export type StabilizerVerdict = (typeof STABILIZER_VERDICTS)[number];

const VersionRef = z.object({ version: z.string().min(1), material: z.string().min(1) });

export const StabilizerCardSchema = z.object({
  ...commonCardFields,
  seat: z.literal('stabilizer'),
  exploration: ExplorationRef,
  /** Required: the maintainer's fuzzy acceptance goal, verbatim. */
  goal: z.string().min(1),
  /** Required: what counts as a hole. */
  attackScope: z.array(z.string().min(1)).min(1),
  /** The decision the exploration serves and its type. */
  decision: z.object({ type: z.enum(['direction', 'structure']), text: z.string().min(1) }),
  /** The attack round judged (1-based). */
  round: z.number().int().positive(),
  /** The version that round attacked: the judgment's target. */
  target: z.string().min(1),
  /** The round's findings, each with the attacker's severity and the author's disposition (none: the round raised nothing; its drift is still judged). */
  findings: z.array(PriorFinding),
  /** Earlier findings judged in scope and not resolved yet (context: they stay in scope). */
  earlier: z.array(PriorFinding),
  /** Required: the first and the current version of the product (must-read materials). */
  firstVersion: VersionRef,
  currentVersion: VersionRef,
  /** The earlier rounds' Stabilizer judgments, as text. */
  earlierJudgments: z.array(z.string()),
  rulings: z.array(z.string()),
  materials: z.array(Material).min(1),
  /** The position judgment's binding inputs (the exploration definition's version; the contract's objects). */
  binding: Binding,
  /** The evidence the version's standing rests on (as the round's attack judgment). */
  requiredEvidence: z.array(z.string()),
  /** Direction questions still waiting for their ruling from before this round (an author's question, an escalated finding, a drift): the position stays pending. */
  pendingDirection: z.array(z.string()).optional(),
});
export type StabilizerCard = z.infer<typeof StabilizerCardSchema>;

export const StabilizerResultShape = {
  findings: z
    .array(
      z.object({
        finding: z.string().describe('The id of a finding of this round on the card.'),
        verdict: z.enum(STABILIZER_VERDICTS).describe('in-scope: a real problem against the definition (the author must answer it); shifts-direction: it, or the fix the author accepted, would change the question, the goal or the direction, or contradicts the user\'s words; out-of-scope: a nitpick outside the attack scope.'),
        severity: z.enum(SEVERITIES).describe('The severity as you judge it (fatal, serious, general, minor); it may differ from the attacker\'s.'),
        reason: z.string().min(1),
        question: z.string().describe('shifts-direction: the question for the Secretary, stated against the definition and the user\'s words. Empty otherwise.'),
      }),
    )
    .describe('Exactly one verdict per finding of this round on the card.'),
  round: z
    .object({
      verdict: z.enum(['on-track', 'drifting']).describe('drifting: the product moved away from the definition across rounds.'),
      reason: z.string().min(1),
      question: z.string().describe('drifting: the question for the Secretary. Empty otherwise.'),
    })
    .describe('The round verdict.'),
};
const StabilizerResultSchema = z.object(StabilizerResultShape);
export type StabilizerResult = z.infer<typeof StabilizerResultSchema>;

/** A finding the round leaves blocking: judged in scope, fatal or serious as judged, not resolved. */
function blockingInScope(f: PriorFindingT, judged: { readonly verdict: StabilizerVerdict; readonly severity: (typeof SEVERITIES)[number] } | undefined): boolean {
  const verdict = judged?.verdict ?? f.scope ?? 'in-scope';
  const severity = judged?.severity ?? f.severity;
  return verdict === 'in-scope' && isBlocking(severity) && f.status !== 'resolved';
}

/**
 * The position's verdict after the round (4.1 §6.3): fail while an in-scope fatal or serious
 * finding is unresolved on the version; undecided while a direction question waits (a finding
 * judged shifting direction, a drifting round, or a finding escalated by the author); pass
 * otherwise.
 */
export function stabilizedVerdict(card: Pick<StabilizerCard, 'findings' | 'earlier' | 'pendingDirection'>, r: StabilizerResult): Verdict {
  const byId = new Map(r.findings.map((x) => [x.finding, x]));
  if ([...card.findings, ...card.earlier].some((f) => blockingInScope(f, byId.get(f.id)))) return 'fail';
  // only a ruling clears a direction question (code review r1 #2): an escalated finding stays pending whatever its verdict
  const direction =
    r.round.verdict === 'drifting' ||
    r.findings.some((x) => x.verdict === 'shifts-direction') ||
    [...card.findings, ...card.earlier].some((f) => f.status === 'awaiting-ruling') ||
    (card.pendingDirection ?? []).length > 0;
  return direction ? 'undecided' : 'pass';
}

function stabilizerProblems(card: StabilizerCard, r: StabilizerResult, read: ReadonlySet<string> | undefined): string[] {
  const out = unreadMustRead(card.materials, read).map((k) => `must-read page ${k} was not read`);
  const ids = card.findings.map((f) => f.id);
  for (const id of ids) {
    const n = r.findings.filter((x) => x.finding === id).length;
    if (n === 0) out.push(`findings: finding "${id}" has no verdict`);
    if (n > 1) out.push(`findings: finding "${id}" is judged ${n} times`);
  }
  for (const x of r.findings) {
    if (!ids.includes(x.finding)) out.push(`findings: "${x.finding}" is not a finding of this round on the card`);
    if (x.verdict === 'shifts-direction' && x.question.trim() === '') out.push(`findings[${x.finding}]: a finding that shifts direction states the question for the Secretary`);
    if (x.verdict !== 'shifts-direction' && x.question.trim() !== '') out.push(`findings[${x.finding}]: only a finding that shifts direction carries a question`);
  }
  if (r.round.verdict === 'drifting' && r.round.question.trim() === '') out.push('round: a drifting round states the question for the Secretary');
  if (r.round.verdict === 'on-track' && r.round.question.trim() !== '') out.push('round: only a drifting round carries a question');
  return out;
}

function stabilizerRecords(card: StabilizerCard, r: StabilizerResult, ctx: CardRecordContext): JudgmentRecord[] {
  const b = card.binding;
  const verdict = stabilizedVerdict(card, r);
  const evidence = card.requiredEvidence.length > 0 ? ctx.content.putList(card.requiredEvidence) : ((b.evidence ?? EMPTY_LIST) as ListRef);
  const rec: JudgmentRecord = {
    kind: 'judgment',
    judgment: b.judgment as JudgmentId,
    review: 'crititor',
    executor: 'stabilizer',
    target: card.target as ObjectVersionId,
    verdict,
    evidence: evidence as ListRef,
    bases: b.bases as ListRef,
    constraints: b.constraints as ListRef,
    reliesOn: b.reliesOn as ListRef,
    issues: [],
    // a pass names the negation it revokes (8.1, 5.2); a fail or a pending judgment revokes nothing
    revokes: verdict === 'pass' ? (b.revokes as JudgmentId | null) : null,
    evidenceUse: b.evidenceUse,
    superseded: b.superseded,
    extends: null,
  };
  validateRecord(rec);
  return [rec];
}

export function renderStabilizerCard(c: StabilizerCard): string {
  return (
    renderCommon(c) +
    renderExploration(c.exploration, c.goal, c.attackScope) +
    `## The decision this serves (${c.decision.type})\n${c.decision.text}\n\n` +
    `## Round ${c.round}: the attack on version ${c.target}\n` +
    `The first version is ${c.firstVersion.version} (material ${c.firstVersion.material}); the current version is ${c.currentVersion.version} (material ${c.currentVersion.material}).\n\n` +
    (c.findings.length > 0
      ? renderPriorFindings("This round's findings with the author's dispositions (judge every one)", c.findings)
      : "## This round's findings\nThe attacker raised none this round: judge the round itself (on track or drifting).\n\n") +
    list('Direction questions still waiting for their ruling (the position stays pending until they are ruled)', c.pendingDirection ?? []) +
    renderPriorFindings('Earlier findings judged in scope and not resolved (context)', c.earlier) +
    list('Earlier rounds\' judgments', c.earlierJudgments) +
    list('Rulings of the decision layer (verbatim)', c.rulings) +
    renderMaterials(c.materials)
  );
}

export const stabilizerEntry: SeatCardEntry<StabilizerCard, StabilizerResult> = {
  kind: 'stabilizer',
  seat: 'stabilizer',
  schema: StabilizerCardSchema,
  resultShape: StabilizerResultShape,
  resultSchema: StabilizerResultSchema,
  toolProfile: 'materials',
  render: renderStabilizerCard,
  problems: (c, r, ctx) => stabilizerProblems(c, r, ctx.materialsRead),
  records: stabilizerRecords,
};

registerSeatCard(stabilizerEntry);
