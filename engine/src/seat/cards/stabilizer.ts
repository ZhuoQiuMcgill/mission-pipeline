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
// Direction findings and drift name the question for the Secretary. On an in-scope finding the
// author revised, or rebutted with an evidence execution, the Stabilizer may judge that the answer
// resolves it (`answered`): it is resolved at once, without the attacker's re-check, so a round
// whose findings are all answered can pass and the exploration converge without another attack.
//
// Records: the judgment of the review position "crititor + stabilizer" (review "crititor") on the
// round's attacked version (4.1 §6.3): refuted while a finding judged in scope and fatal or
// serious is unresolved on it; pending ("undecided") while a direction question waits for a
// ruling (this round's, or one still pending from before: an author's question, an escalated
// finding, a drift); passed otherwise (naming the negation it revokes). A finding judged out of
// scope or shifting direction never refutes the version. An answered rebuttal resolves its
// finding on the attacked version; an answered revision only on the version that carries it.
// When the author's revision made a version the round did not attack, and the answered findings
// leave nothing on it unresolved or waiting for a ruling, a second judgment of the same position
// passes that version (`<judgment>.revision`): the version the exploration converges on.

import { z } from 'zod';
import type { IssueId, JudgmentId, ObjectVersionId } from '../../common/ids.ts';
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
        answered: z
          .boolean()
          .optional()
          .describe('in-scope, on a finding the author revised or rebutted with an evidence execution: true when the revision (in the current version) or the rebuttal answers it. It is then resolved without the attacker\'s re-check, and a round left with nothing unresolved passes. Omit it (or false) otherwise.'),
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

type Judged = StabilizerResult['findings'][number];

/**
 * A finding the Stabilizer may judge answered: the author revised it, or rebutted it with an
 * evidence execution, and it waits for the attacker's re-check (or an earlier judgment of this
 * same round answered it already). An escalated finding is a direction question: never answered.
 */
export function answerable(f: Pick<PriorFindingT, 'status' | 'disposition' | 'answered'>): boolean {
  const d = f.disposition;
  const answer = d !== null && (d.action === 'revise' || (d.action === 'rebut' && d.evidence !== null));
  return answer && (f.status === 'awaiting-recheck' || (f.status === 'resolved' && f.answered !== undefined));
}

/**
 * Resolved on the version judged: by this judgment's `answered` (a rebuttal on any version, a
 * revision on the version that carries it), or before it (an earlier answer counts only when this
 * judgment of the same round gives it again).
 */
function resolvedOn(f: PriorFindingT, judged: Judged | undefined, revision: boolean): boolean {
  if (judged?.answered === true) return revision || f.disposition?.action === 'rebut';
  return f.status === 'resolved' && f.answered === undefined;
}

/** A finding the round leaves blocking: judged in scope, fatal or serious as judged, not resolved on the version judged. */
function blockingInScope(f: PriorFindingT, judged: Judged | undefined, revision: boolean): boolean {
  const verdict = judged?.verdict ?? f.scope ?? 'in-scope';
  const severity = judged?.severity ?? f.severity;
  return verdict === 'in-scope' && isBlocking(severity) && !resolvedOn(f, judged, revision);
}

/**
 * The position's verdict after the round (4.1 §6.3): fail while an in-scope fatal or serious
 * finding is unresolved on the version; undecided while a direction question waits (a finding
 * judged shifting direction, a drifting round, or a finding escalated by the author); pass
 * otherwise.
 */
export function stabilizedVerdict(card: Pick<StabilizerCard, 'findings' | 'earlier' | 'pendingDirection' | 'target' | 'currentVersion'>, r: StabilizerResult): Verdict {
  return verdictOn(card, r, card.target === card.currentVersion.version);
}

/**
 * The pass the Stabilizer's `answered` verdicts make on the author's revision (4.1 §6.3): when the
 * current version is not the one the round attacked, at least one finding is answered, and on that
 * version nothing in scope, fatal or serious, is left unresolved and no direction question waits.
 * Null otherwise (the attacker's next round judges the revision, as before).
 */
export function stabilizedRevision(card: Pick<StabilizerCard, 'findings' | 'earlier' | 'pendingDirection' | 'target' | 'currentVersion' | 'binding'>, r: StabilizerResult): { readonly version: string; readonly judgment: string } | null {
  if (card.currentVersion.version === card.target || !r.findings.some((x) => x.answered === true)) return null;
  if (verdictOn(card, r, true) !== 'pass') return null;
  return { version: card.currentVersion.version, judgment: revisionJudgment(card.binding.judgment) };
}

/** The id of the pass on the author's revision: the round's judgment id, suffixed. */
export const revisionJudgment = (judgment: string): string => `${judgment}.revision`;

function verdictOn(card: Pick<StabilizerCard, 'findings' | 'earlier' | 'pendingDirection'>, r: StabilizerResult, revision: boolean): Verdict {
  const byId = new Map(r.findings.map((x) => [x.finding, x]));
  if ([...card.findings, ...card.earlier].some((f) => blockingInScope(f, byId.get(f.id), revision))) return 'fail';
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
    if (x.answered === true) {
      const f = card.findings.find((y) => y.id === x.finding);
      if (x.verdict !== 'in-scope') out.push(`findings[${x.finding}]: only an in-scope finding is answered (one out of scope never binds the author; a direction goes to the Secretary)`);
      else if (f !== undefined && f.disposition?.action === 'escalate') out.push(`findings[${x.finding}]: the author escalated it: a direction question waits for its ruling and is never answered`);
      else if (f !== undefined && !answerable(f)) out.push(`findings[${x.finding}]: only a finding the author revised, or rebutted with an evidence execution, can be answered`);
    }
  }
  if (r.round.verdict === 'drifting' && r.round.question.trim() === '') out.push('round: a drifting round states the question for the Secretary');
  if (r.round.verdict === 'on-track' && r.round.question.trim() !== '') out.push('round: only a drifting round carries a question');
  return out;
}

function stabilizerRecords(card: StabilizerCard, r: StabilizerResult, ctx: CardRecordContext): JudgmentRecord[] {
  const b = card.binding;
  const verdict = stabilizedVerdict(card, r);
  // an answered rebuttal: the version's standing rests on its evidence execution too (as on a re-checked one)
  const answered = card.findings.filter((f) => r.findings.some((x) => x.finding === f.id && x.answered === true));
  const rebuttals = answered.flatMap((f) => (f.disposition?.action === 'rebut' && f.disposition.evidence !== null ? [f.disposition.evidence] : []));
  const required = rebuttals.length > 0 ? [...new Set([...card.requiredEvidence, ...rebuttals])] : card.requiredEvidence;
  const evidence = required.length > 0 ? ctx.content.putList(required) : ((b.evidence ?? EMPTY_LIST) as ListRef);
  // the answered findings resolved on the version judged, as the issue responses a re-check would give
  const fixed = (revision: boolean) => answered.filter((f) => revision || f.disposition?.action === 'rebut').map((f) => ({ issue: f.id as IssueId, response: 'fixed' as const }));
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
    issues: fixed(card.target === card.currentVersion.version),
    // a pass names the negation it revokes (8.1, 5.2); a fail or a pending judgment revokes nothing
    revokes: verdict === 'pass' ? (b.revokes as JudgmentId | null) : null,
    evidenceUse: b.evidenceUse,
    superseded: b.superseded,
    extends: null,
  };
  validateRecord(rec);
  const rv = stabilizedRevision(card, r);
  if (rv === null) return [rec];
  // the author's revision, which no attacker judged yet: passed by the same position on the
  // Stabilizer's answers, with the round's contract inputs (every version of the product has the
  // same scope, basis line and reliances within a phase); nothing negated it, so it revokes nothing
  const onRevision: JudgmentRecord = { ...rec, judgment: rv.judgment as JudgmentId, target: rv.version as ObjectVersionId, verdict: 'pass', issues: fixed(true), revokes: null };
  validateRecord(onRevision);
  return [rec, onRevision];
}

export function renderStabilizerCard(c: StabilizerCard): string {
  return (
    renderCommon(c) +
    renderExploration(c.exploration, c.goal, c.attackScope) +
    `## The decision this serves (${c.decision.type})\n${c.decision.text}\n\n` +
    `## Round ${c.round}: the attack on version ${c.target}\n` +
    `The first version is ${c.firstVersion.version} (material ${c.firstVersion.material}); the current version is ${c.currentVersion.version} (material ${c.currentVersion.material}).\n\n` +
    (c.findings.length > 0
      ? renderPriorFindings("This round's findings with the author's dispositions (judge every one)", c.findings) +
        (c.findings.some((f) => answerable(f))
          ? `When the author's revision${c.currentVersion.version !== c.target ? ` (in version ${c.currentVersion.version})` : ''} or rebuttal answers an in-scope finding, say so with \`answered\`: it is resolved without another attack round, and a round left with nothing unresolved passes.\n\n`
          : '')
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
