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
import { Binding, Item, Material, commonCardFields, list, renderCommon, renderMaterials, unreadMustRead } from './common.ts';
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
  'plan-restarts-work',
  'plan-structure-change',
] as const;
export type EscalationSource = (typeof ESCALATION_SOURCES)[number];

/** What the program can do with a decision, mechanically. */
export const DECISION_OPTIONS = ['accept', 'accept-risk', 'send-back', 'replan', 'grant', 'restart', 'abandon', 'answer', 'rework', 'ask-user', 'ask-pm', 'approve'] as const;
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
  authorizations: z.array(z.object({ id: z.string().min(1), version: z.string().optional(), quote: z.string().min(1), notifyCondition: z.string().nullable() })),
  items: z.array(Item),
  contextItems: z.array(z.object({ line: z.string(), version: z.string(), type: z.string() })).optional(),
  materials: z.array(Material).min(1),
  /** The choices the program can carry out for this escalation. */
  options: z.array(z.object({ id: z.enum(DECISION_OPTIONS), label: z.string().min(1), outcome: z.string().min(1) })).min(1),
  /** 6.5: the Secretary's one extra grant on this lineage is still unused. */
  grantAvailable: z.boolean(),
  classifications: z.array(z.enum(['detail', 'needs-pm'])).optional(),
  /** A negated review position this decision rules on (accepting it records a pass that revokes the negation). */
  position: z.object({ target: z.string().min(1), review: z.string().min(1), revokes: z.string().min(1), binding: Binding }).nullable(),
  /** 4.1.2: the earlier decisions on the same subject: the decision, its reason, and whether it was carried out. */
  earlierDecisions: z.array(z.object({ escalation: z.string(), source: z.string(), option: z.string(), by: z.string(), reason: z.string(), applied: z.enum(['carried out', 'not carried out yet', 'closed as superseded']) })).optional(),
});
export type SecretaryCard = z.infer<typeof SecretaryCardSchema>;

export const SecretaryResultShape = {
  option: z.enum(DECISION_OPTIONS).describe('One of the options on the card.'),
  classification: z
    .enum(['detail', 'important-within-authority', 'needs-user', 'needs-pm'])
    .describe('detail: recorded only; important-within-authority: takes effect and the PM is told (cite the authorization); needs-user: related work pauses and the user decides (option "ask-user").'),
  authorization: z.string().nullable().describe('The authorization id you rely on (required for important-within-authority).'),
  reason: z.string().describe('Why, in a few sentences.'),
  instructions: z.string().describe('For send-back, replan, rework and answer: what exactly must change, or the decision itself. For "grant" on an exploration (optional): what the next round must do; it is shown on that round\'s cards. Empty otherwise.'),
  grantExtra: z.number().int().min(0).max(2).describe('For "grant": 1 or 2 extra attempts; 0 otherwise.'),
  findings: z
    .array(z.string().min(1))
    .optional()
    .describe('For "grant" on an exploration (optional): the ids of the findings the granted round is for, general ones too, as the reasons list them. The author gets a turn on them. Omit otherwise.'),
  notice: z.string().describe('What the PM is told (empty only for a detail).'),
  mayMatter: z.boolean().describe('A detail that is clearly reversible but the user might care about: noted as "may matter".'),
};
const SecretaryResultSchema = z.object(SecretaryResultShape);
export type SecretaryResult = z.infer<typeof SecretaryResultSchema>;


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
    list(`Earlier decisions on ${r.subject} (decide this one knowing them)`, (c.earlierDecisions ?? []).map((d) => `${d.escalation} (${d.source}): ${d.option} by ${d.by}${d.reason !== '' ? `: ${d.reason}` : ''} (${d.applied})`)) +
    '## Classification\nNew decisions: detail (with mayMatter when relevant), or needs-pm with ask-pm. A replan that adds or drops deliverables, changes module interfaces, data formats or storage needs the PM.\n\n' +
    list('Options', c.options.map((o) => `${o.id}: ${o.label}. Outcome: ${o.outcome}`)) +
    `## Your extra grant on lineage ${r.lineage}\n${c.grantAvailable ? 'Available (once per lineage, at most 2 attempts).' : c.classifications !== undefined ? 'Already used: ask the PM for further grants (choose ask-pm).' : 'Already used: only the user can grant more (choose ask-user if more attempts are the only way).'}\n\n`
  );
}

export function secretaryProblems(c: SecretaryCard, r: SecretaryResult, read: ReadonlySet<string> | undefined): string[] {
  const out = unreadMustRead(c.materials, read).map((k) => `must-read page ${k} was not read`);
  if (c.classifications !== undefined && r.classification === 'important-within-authority') out.push('classification: new decisions use detail or needs-pm; PM-class questions go to the PM');
  if (c.classifications !== undefined && (c.request.source === 'plan-structure-change' || c.request.source === 'plan-restarts-work') && !isAskOption(r.option)) out.push('plan structure is the PM’s decision');
  if (!c.options.some((o) => sameDecisionOption(o.id, r.option))) out.push(`option: "${r.option}" is not an option on the card (${c.options.map((o) => o.id).join(', ')})`);
  if (isAskOption(r.option) !== (r.classification === 'needs-user' || r.classification === 'needs-pm')) out.push('classification: "needs-user" goes with option "ask-user", and only with it');
  if (r.classification === 'important-within-authority' && (r.authorization === null || !c.authorizations.some((a) => a.id === r.authorization))) {
    out.push('authorization: an important decision within authority cites one of the card\'s authorizations');
  }
  if (r.authorization !== null && !c.authorizations.some((a) => a.id === r.authorization)) out.push(`authorization: "${r.authorization}" is not on the card`);
  if (r.option === 'grant') {
    if (!c.grantAvailable) out.push('option: your grant on this lineage is used; choose another option (ask-user for more attempts)');
    if (r.grantExtra < 1) out.push('grantExtra: give 1 or 2 extra attempts');
  } else if (r.grantExtra !== 0) out.push('grantExtra: only for option "grant"');
  if (r.option !== 'grant' && (r.findings ?? []).length > 0) out.push('findings: only for option "grant"');
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
  toolProfile: 'materials',
  render: renderSecretary,
  problems: (c, r, ctx) => secretaryProblems(c, r, ctx.materialsRead),
  // the Secretary's hand-back records its decision only: the ruling that accepting a negated position
  // makes (rulingJudgment's pass) is written by the owning flow in the write that carries the decision
  // out (flow/secretary.ts carryOut), so a decision overridden, closed or never carried out writes none
  records: () => [],
};

registerSeatCard(secretaryEntry);

export function isAskOption(option: string): boolean { return option === 'ask-user' || option === 'ask-pm'; }
export function sameDecisionOption(a: string, b: string): boolean { return a === b || (isAskOption(a) && isAskOption(b)); }
