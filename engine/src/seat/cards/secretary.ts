// The Secretary's card (design 3.8, 3.2, 6.5, 7.1).
//
// A one-shot instance the program starts for one escalated decision. It has no file tool and no
// shell: it reads the decision card's materials page by page (the must-read list is enforced) and
// hands back one choice among the options the program offers for this kind of escalation, so
// the program can apply it mechanically. It classifies the decision by 3.2: a detail (recorded
// in layer 2 only), important and within a recorded authorization (takes effect, the PM is told),
// or one the user must make (related work pauses, the PM is told and asks the user). "Clearly
// reversible but unsure whether the user cares" is a detail with the "may matter" note.
//
// Accepting a negated review position (Calibrator ② escalation, feasibility items left
// unresolved) is a ruling on that position (8.1 "争议裁决"): the card names the position and the
// negation, and the accepted hand-back becomes a pass judgment that revokes it.

import { z } from 'zod';
import type { JudgmentId, ObjectVersionId } from '../../common/ids.ts';
import type { JudgmentRecord, ListRef } from '../../common/records.ts';
import { validateRecord } from '../../common/validate.ts';
import { Binding, Item, Material, TOOLS_NOTE_MATERIALS, commonCardFields, list, renderCommon, renderMaterials, unreadMustRead } from './common.ts';
import { EMPTY_LIST } from './calibrator.ts';
import { registerSeatCard, type SeatCardEntry } from './registry.ts';

/** 3.8 "上报来源", plus the program's own escalations that 6.2 and 6.5 route to the Secretary. */
export const ESCALATION_SOURCES = [
  'calibrator-2',
  'order-change',
  'feasibility-unresolved',
  'reviewer-needs-decision',
  'loop-exhausted',
  'constructor-decision',
  'exploration-direction',
  'exploration-budget',
  'exploration-repeated-fatal',
  'issue-disposition',
  'needs-disposition',
  'replan',
  'cost-overrun',
] as const;
export type EscalationSource = (typeof ESCALATION_SOURCES)[number];

/** What the program can do with a decision, mechanically. */
export const DECISION_OPTIONS = ['accept', 'accept-risk', 'send-back', 'replan', 'grant', 'restart', 'abandon', 'answer', 'rework', 'ask-user'] as const;
export type DecisionOption = (typeof DECISION_OPTIONS)[number];

export const SecretaryCardSchema = z.object({
  ...commonCardFields,
  seat: z.literal('secretary'),
  /** Required: the item, the original and the changed form, the escalating party's reasons. */
  request: z.object({
    id: z.string().min(1),
    source: z.enum(ESCALATION_SOURCES),
    lineage: z.string().min(1),
    subject: z.string().min(1),
    summary: z.string().min(1),
    original: z.string(),
    changed: z.string(),
    reasons: z.array(z.string()),
  }),
  /** Required: the related authorizations verbatim (with their notify conditions), the items involved, the alignment record. */
  authorizations: z.array(z.object({ id: z.string().min(1), quote: z.string().min(1), notifyCondition: z.string().nullable() })),
  items: z.array(Item),
  materials: z.array(Material).min(1),
  /** The choices the program can carry out for this escalation. */
  options: z.array(z.object({ id: z.enum(DECISION_OPTIONS), label: z.string().min(1), outcome: z.string().min(1) })).min(1),
  /** 6.5: the Secretary's one extra grant on this lineage is still unused. */
  grantAvailable: z.boolean(),
  /** A negated review position this decision rules on (accepting it records a pass that revokes the negation). */
  position: z.object({ target: z.string().min(1), review: z.string().min(1), revokes: z.string().min(1), binding: Binding }).nullable(),
});
export type SecretaryCard = z.infer<typeof SecretaryCardSchema>;

export const SecretaryResultShape = {
  option: z.enum(DECISION_OPTIONS).describe('One of the options on the card.'),
  classification: z
    .enum(['detail', 'important-within-authority', 'needs-user'])
    .describe('detail: recorded only; important-within-authority: takes effect and the PM is told (cite the authorization); needs-user: related work pauses and the user decides (option "ask-user").'),
  authorization: z.string().nullable().describe('The authorization id you rely on (required for important-within-authority).'),
  reason: z.string().describe('Why, in a few sentences.'),
  instructions: z.string().describe('For send-back, replan, rework and answer: what exactly must change, or the decision itself. Empty otherwise.'),
  grantExtra: z.number().int().min(0).max(2).describe('For "grant": 1 or 2 extra attempts; 0 otherwise.'),
  notice: z.string().describe('What the PM is told (empty only for a detail).'),
  mayMatter: z.boolean().describe('A detail that is clearly reversible but the user might care about: noted as "may matter".'),
};
const SecretaryResultSchema = z.object(SecretaryResultShape);
export type SecretaryResult = z.infer<typeof SecretaryResultSchema>;

export const SECRETARY_DEFINITION = [
  'You are the Secretary seat of a software pipeline: a one-shot decider for one escalated question. The card in the first message says what was escalated, by whom and why, which authorizations the user recorded, and which options the program can carry out.',
  TOOLS_NOTE_MATERIALS,
  'Decide within the recorded authority. Only three kinds of decision go to the user: one that changes what the user gets (scope, delivery form, visible behaviour); one that is hard to undo (external interfaces, data formats and storage, overall architecture, irreversible operations, commitments to others), including any where you cannot tell whether it can be undone; and one that conflicts with what the user said. Everything else is a detail.',
  'Classify your decision: "detail" (recorded only; set mayMatter when it is clearly reversible but the user might care); "important-within-authority" (a recorded authorization covers it: cite it; it takes effect and the PM is told); "needs-user" (choose option "ask-user": related work pauses and the PM asks the user). When unsure between deciding and asking, ask.',
  'Pick exactly one option from the card. For send-back, replan, rework and answer write the instructions the next seat will get. For grant (only when the card says your grant is available) give 1 or 2 extra attempts and a reason; when the same failure keeps repeating, prefer a different approach over more attempts. Write the notice the PM reads unless it is a detail. Call submit_result once, then end your turn.',
  'Upstream: the program, which escalated this to you. Downstream: the program carries out your choice and notifies the PM.',
].join('\n\n');

export function renderSecretary(c: SecretaryCard): string {
  const r = c.request;
  return (
    renderCommon(c) +
    `## Escalation ${r.id} (${r.source}) on ${r.subject}\n${r.summary}\n\n` +
    (r.original !== '' ? `## Original\n${r.original}\n\n` : '') +
    (r.changed !== '' ? `## Changed\n${r.changed}\n\n` : '') +
    list("The escalating party's reasons", r.reasons) +
    list('Authorizations (verbatim)', c.authorizations.map((a) => `[${a.id}] "${a.quote}"${a.notifyCondition !== null ? ` (tell the user when: ${a.notifyCondition})` : ''}`)) +
    list('Requirement items involved', c.items.map((i) => `[${i.id}] ${i.text}`)) +
    renderMaterials(c.materials) +
    list('Options', c.options.map((o) => `${o.id}: ${o.label}. Outcome: ${o.outcome}`)) +
    `## Your extra grant on lineage ${r.lineage}\n${c.grantAvailable ? 'Available (once per lineage, at most 2 attempts).' : 'Already used: only the user can grant more (choose ask-user if more attempts are the only way).'}\n\n` +
    'When done, call submit_result with one option, its classification and the notice; then end your turn.'
  );
}

export function secretaryProblems(c: SecretaryCard, r: SecretaryResult, read: ReadonlySet<string> | undefined): string[] {
  const out = unreadMustRead(c.materials, read).map((k) => `must-read page ${k} was not read`);
  if (!c.options.some((o) => o.id === r.option)) out.push(`option: "${r.option}" is not an option on the card (${c.options.map((o) => o.id).join(', ')})`);
  if ((r.option === 'ask-user') !== (r.classification === 'needs-user')) out.push('classification: "needs-user" goes with option "ask-user", and only with it');
  if (r.classification === 'important-within-authority' && (r.authorization === null || !c.authorizations.some((a) => a.id === r.authorization))) {
    out.push('authorization: an important decision within authority cites one of the card\'s authorizations');
  }
  if (r.authorization !== null && !c.authorizations.some((a) => a.id === r.authorization)) out.push(`authorization: "${r.authorization}" is not on the card`);
  if (r.option === 'grant') {
    if (!c.grantAvailable) out.push('option: your grant on this lineage is used; choose another option (ask-user for more attempts)');
    if (r.grantExtra < 1) out.push('grantExtra: give 1 or 2 extra attempts');
  } else if (r.grantExtra !== 0) out.push('grantExtra: only for option "grant"');
  if ((r.option === 'send-back' || r.option === 'replan' || r.option === 'rework' || r.option === 'answer') && r.instructions.trim() === '') out.push(`instructions: option "${r.option}" needs the instructions`);
  if (r.classification !== 'detail' && r.notice.trim() === '') out.push('notice: write what the PM is told');
  if (r.reason.trim() === '') out.push('reason: say why');
  return out;
}

/** Accepting a negated position: the ruling's pass, revoking the negation (8.1, 5.2). */
export function rulingJudgment(c: SecretaryCard, executor: string): JudgmentRecord | null {
  const p = c.position;
  if (p === null) return null;
  const b = p.binding;
  const rec: JudgmentRecord = {
    kind: 'judgment',
    judgment: b.judgment as JudgmentId,
    review: p.review,
    executor,
    target: p.target as ObjectVersionId,
    verdict: 'pass',
    evidence: (b.evidence ?? EMPTY_LIST) as ListRef,
    bases: b.bases as ListRef,
    constraints: b.constraints as ListRef,
    reliesOn: b.reliesOn as ListRef,
    issues: [],
    revokes: p.revokes as JudgmentId,
    evidenceUse: b.evidenceUse,
    superseded: [],
    extends: null,
  };
  validateRecord(rec);
  return rec;
}

const secretaryEntry: SeatCardEntry<SecretaryCard, SecretaryResult> = {
  kind: 'secretary',
  seat: 'secretary',
  schema: SecretaryCardSchema,
  resultShape: SecretaryResultShape,
  resultSchema: SecretaryResultSchema,
  definition: SECRETARY_DEFINITION,
  toolProfile: 'materials',
  render: renderSecretary,
  problems: (c, r, ctx) => secretaryProblems(c, r, ctx.materialsRead),
  records: (c, r) => {
    if (r.option !== 'accept' && r.option !== 'accept-risk') return [];
    const j = rulingJudgment(c, 'secretary');
    return j === null ? [] : [j];
  },
};

registerSeatCard(secretaryEntry);
