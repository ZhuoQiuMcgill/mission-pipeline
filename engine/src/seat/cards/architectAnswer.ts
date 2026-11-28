// 4.4 (G1, PM design §4): the Architect's card that answers one question of design, in one step. A decider
// (the Secretary, or the PM on the user's words) chose `ask-architect` on a Constructor's questions, a
// Reviewer's "needs a decision" or a used-up rework loop. A read-only seat, as the repair Architect is: the
// task's card in the plan in effect, the question and the decider's instructions, with the task's hand-back,
// its last review and its accepted product readable (F3). It changes no card, no standard, no write path and
// no structure, so no plan review follows: its hand-back is exactly one of three replies, and the program
// refuses anything else.
//   answer            recorded on the escalation that asked, as its answer (flow/architectAsk.ts)
//   plan-must-change  what must change and why: the escalation goes back to the decider that asked
//   need-to-know      the Architect's question: the escalation goes back to the decider that asked

import { z } from 'zod';
import { DetailedTask } from '../../flow/plandoc.ts';
import { ESCALATION_SOURCES } from './secretary.ts';
import { Item, Material, ReadOnlyWorkspace, commonCardFields, list, renderCommon, renderMaterials } from './common.ts';
import { registerSeatCard, type SeatCardEntry } from './registry.ts';

export const ARCHITECT_ANSWER_CARD = 'architect-answer';

/** The most characters a reply's text (and its why) may have: the reply reaches cards; detail goes in the report. */
export const REPLY_MAX_CHARS = 10_000;

export const ArchitectAnswerCardSchema = z.object({
  ...commonCardFields,
  seat: z.literal('architect-answer'),
  workspace: ReadOnlyWorkspace,
  /** The escalation that asked: the question is its summary and reasons (a returned round's reasons included). */
  escalation: z.object({ id: z.string().min(1), source: z.enum(ESCALATION_SOURCES), subject: z.string().min(1), summary: z.string().min(1), reasons: z.array(z.string()) }),
  /** Who asked, at which round (the Secretary's decision round, or the PM's answer round), with that decision's instructions and reason. */
  asked: z.object({ by: z.enum(['secretary', 'pm']), round: z.number().int().nonnegative(), instructions: z.string(), reason: z.string() }),
  /** The task the question is about: its card in the plan in effect (`task` is this card's own step), and the attempt it was raised on. */
  taskCard: DetailedTask,
  attempt: z.number().int().positive().nullable(),
  dplan: z.string().min(1),
  requirementItems: z.array(Item),
  /** The task's accepted product, readable with `mp seat <id> checkout --product <task>` (empty: none). */
  accepted: z.array(z.object({ task: z.string().min(1), product: z.string().min(1), attempt: z.number().int().positive(), changedPaths: z.array(z.string()), commit: z.string().min(1).optional() })),
  /** Earlier replies of an Architect on this escalation, oldest first. */
  earlier: z.array(z.object({ step: z.string(), reply: z.string(), text: z.string() })),
  /** The other tasks of the plan in effect: an answer may name them. */
  tasks: z.array(z.string()),
  materials: z.array(Material).optional(),
});
export type ArchitectAnswerCard = z.infer<typeof ArchitectAnswerCardSchema>;

export const ArchitectAnswerResultShape = {
  reply: z.enum(['answer', 'plan-must-change', 'need-to-know']).describe('answer: you answer the question; plan-must-change: the answer would change the plan (a card, a standard, a write path, a task or an interface); need-to-know: you must know something first.'),
  text: z.string().describe('answer: the answer, as the task\'s next cards should read it; plan-must-change: what must change; need-to-know: your question.'),
  why: z.string().optional().describe('plan-must-change only (required there): why the plan must change.'),
  tasks: z.array(z.string()).optional().describe('answer only (optional): other tasks of the plan the answer concerns; it is printed on their cards too.'),
};
// anything but the three replies is refused: this card changes nothing (an edit of a card or of the plan is "plan-must-change")
const ArchitectAnswerResultSchema = z.strictObject(ArchitectAnswerResultShape, {
  error: (iss) => (iss.code === 'unrecognized_keys' ? `${iss.keys.join(', ')}: not a field of this hand-back. You change nothing here: hand back reply, text, why and tasks only (a change of a card, a standard or the plan is reply "plan-must-change", with what and why)` : undefined),
});
export type ArchitectAnswerResult = z.infer<typeof ArchitectAnswerResultSchema>;

const WHO = { secretary: 'The Secretary', pm: 'The PM' } as const;

export function renderArchitectAnswer(c: ArchitectAnswerCard): string {
  const t = c.taskCard;
  const e = c.escalation;
  return (
    renderCommon(c) +
    `## The question\nEscalation ${e.id} (${e.source}) on ${e.subject}${c.attempt !== null ? `, attempt ${c.attempt}` : ''}: ${e.summary}\n\n` +
    list('What it asks (its reasons)', e.reasons) +
    `## Who asks you\n${WHO[c.asked.by]} asks you: ${c.asked.instructions.trim() || '(no instructions)'}${c.asked.reason.trim() !== '' ? `\nIts reason: ${c.asked.reason.trim()}` : ''}\n\n` +
    list('Earlier replies of an Architect on this escalation', c.earlier.map((x) => `${x.step}: ${x.reply}: ${x.text}`)) +
    `## Task ${t.id} (${t.kind}${t.module !== null ? ` of ${t.module}` : ''}), as the plan in effect (${c.dplan}) has it\nGoal: ${t.goal}\nWrites: ${t.writeScope.join(', ') || 'nothing'}; reads: ${t.readableFiles.join(', ') || 'nothing listed'}; depends on: ${t.dependsOn.join(', ') || 'nothing'}; implements: ${t.implements.join(', ') || 'none'}; calls: ${t.calls.join(', ') || 'none'}\n\n` +
    list('Its acceptance standards', t.standards.map((s) => `[${s.id}] ${s.text}`)) +
    list('Its requirement items', c.requirementItems.map((i) => `[${i.id}] ${i.text}`)) +
    list('Its accepted product (read it with checkout --product <task>)', c.accepted.map((a) => `${a.task}: ${a.product} (attempt ${a.attempt}${a.commit !== undefined ? `, commit ${a.commit}` : ''}): ${a.changedPaths.join(', ') || 'no path'}`)) +
    list('The other tasks of the plan (an answer may name them)', c.tasks) +
    '## What to hand back\nAnswer what the plan leaves open, as the plan\'s Architect would decide it. You change nothing: no card text, no standard, no write path, no structure. Hand back exactly one reply:\n' +
    '- `answer`: the answer in `text`. It is recorded on this escalation as its answer and reaches the task\'s next cards. Name other tasks it concerns in `tasks`.\n' +
    '- `plan-must-change`: the answer would change the plan (a card, a standard, a write path, a task or an interface): what must change in `text`, why in `why`. The escalation goes back to who asked you: a change of the plan is a re-plan with its reviews, or the PM\'s.\n' +
    '- `need-to-know`: what you must know first, as a question in `text`. The escalation goes back to who asked you.\n\n' +
    renderMaterials(c.materials ?? [], c.materialsNotAttached ?? [])
  );
}

/** The program's rules on the hand-back: one reply, its text, a why only for a plan change, other tasks only for an answer. */
export function answerProblems(c: ArchitectAnswerCard, r: ArchitectAnswerResult): string[] {
  const out: string[] = [];
  if (r.text.trim() === '') out.push(`text: give ${r.reply === 'answer' ? 'the answer' : r.reply === 'plan-must-change' ? 'what must change in the plan' : 'your question'}`);
  if (r.text.length > REPLY_MAX_CHARS) out.push(`text: at most ${REPLY_MAX_CHARS} characters (it reaches the cards); put the detail in your report`);
  const why = r.why ?? '';
  if (r.reply === 'plan-must-change' && why.trim() === '') out.push('why: say why the plan must change');
  if (r.reply !== 'plan-must-change' && why.trim() !== '') out.push(`why: only for reply "plan-must-change"`);
  if (why.length > REPLY_MAX_CHARS) out.push(`why: at most ${REPLY_MAX_CHARS} characters; put the detail in your report`);
  const named = r.tasks ?? [];
  if (r.reply !== 'answer' && named.length > 0) out.push('tasks: only with reply "answer"');
  for (const x of new Set(named)) if (x !== c.taskCard.id && !c.tasks.includes(x)) out.push(`tasks: "${x}" is not a task of the plan in effect (on the card: ${c.tasks.join(', ') || 'none'})`);
  return out;
}

const entry: SeatCardEntry<ArchitectAnswerCard, ArchitectAnswerResult> = {
  kind: ARCHITECT_ANSWER_CARD,
  seat: 'architect',
  schema: ArchitectAnswerCardSchema,
  resultShape: ArchitectAnswerResultShape,
  resultSchema: ArchitectAnswerResultSchema,
  toolProfile: 'read',
  render: renderArchitectAnswer,
  problems: (c, r) => answerProblems(c, r),
  // the flow records the reply on the escalation (flow/architectAsk.ts), not the hand-back
  records: () => [],
};

registerSeatCard(entry);
