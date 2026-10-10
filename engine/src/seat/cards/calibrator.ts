// The Calibrator's two cards (design 3.3 Calibrator ①, 3.7 Calibrator ②, 5.2 part 5, 7.1, 10.1).
//
// Calibrator ① audits the direction of the PM plan against the user's words, once per
// alignment batch. Calibrator ② audits the Architect's supplements to the detailed plan and the
// fidelity of its provenance mapping. Both have no file tool and no shell: they read their
// materials page by page (the material tool), and the program refuses the hand-back until every
// page on the must-read list was read (7.1). Both may review only the changes of a batch as a
// continuation judgment (5.2 part 5): the card then names J0 and holds the old and the new full
// text; a seat that cannot judge the reach of a change answers "needs-full-review" and the
// program runs a full review instead (not a verdict, not counted).
//
// The verdict becomes a judgment on the plan version's review position (calibrator-1 /
// calibrator-2), bound by the card's contract inputs (`binding`).

import { z } from 'zod';
import type { JudgmentId, ObjectVersionId } from '../../common/ids.ts';
import type { JudgmentRecord, ListRef, Verdict } from '../../common/records.ts';
import { validateRecord } from '../../common/validate.ts';
import { Binding, Material, TOOLS_NOTE_MATERIALS, commonCardFields, list, renderCommon, renderMaterials, unreadMustRead, type CardBinding } from './common.ts';
import { registerSeatCard, type SeatCardEntry } from './registry.ts';

const Mode = z.discriminatedUnion('kind', [z.object({ kind: z.literal('full') }), z.object({ kind: z.literal('continuation'), extends: z.string().min(1) })]);

const Element = z.object({
  id: z.string().min(1),
  text: z.string().min(1),
  /** What the plan claims: "user" (with the quote) or "pm" / "architect" (a supplement). */
  provenance: z.string().min(1),
  /** Calibrator ②: the PM plan element it maps to, if the plan says so. */
  mapsTo: z.string().nullable().optional(),
});

// ---------------------------------------------------------------- Calibrator ① (3.3)

export const Calibrator1CardSchema = z.object({
  ...commonCardFields,
  seat: z.literal('calibrator-1'),
  /** The PM plan version (object) and its review position. */
  target: z.string().min(1),
  review: z.literal('calibrator-1'),
  mode: Mode,
  /** Required: user words of the batch, changed items (old and new), dependent items, the plan's new (and old) full text, authorizations. */
  materials: z.array(Material).min(1),
  /** Every element of the plan (the judged ones are `focus`). */
  elements: z.array(Element).min(1),
  /** Elements to judge: all in a full review; the changed and affected ones in a continuation. */
  focus: z.array(z.string()).min(1),
  /** The explorations the plan defines (ids), for the extra checks. */
  explorations: z.array(z.string()),
  binding: Binding,
});
export type Calibrator1Card = z.infer<typeof Calibrator1CardSchema>;

export const Calibrator1ResultShape = {
  elements: z
    .array(
      z.object({
        element: z.string().describe('An element id from the focus list.'),
        finding: z
          .enum(['user-said', 'detail-within-authority', 'ask-user', 'contradicts-user'])
          .describe('user-said: the quoted words say it; detail-within-authority: a PM supplement inside a recorded authorization; ask-user: an important design decision the user must make; contradicts-user: it goes against what the user said.'),
        quotes: z.array(z.string()).describe('Material pointers "<material>#<page>" holding the words you checked against.'),
        reason: z.string(),
      }),
    )
    .describe('Exactly one finding per focus element.'),
  errors: z
    .array(
      z.object({
        kind: z.enum(['fabricated', 'omitted', 'distorted', 'premise-invalid', 'contradictory']),
        elements: z.array(z.string()),
        detail: z.string(),
      }),
    )
    .describe('The five error kinds: made up, left out, distorted, a premise that does not hold, elements contradicting each other.'),
  explorations: z
    .array(z.object({ exploration: z.string(), presetAnswer: z.boolean(), jumpsAhead: z.boolean(), detail: z.string() }))
    .describe('For each exploration: does its definition preset the answer; does the plan go past it before it stands.'),
  questions: z.array(z.object({ element: z.string(), question: z.string(), why: z.enum(['deliverable', 'irreversible', 'conflict']) })).describe('What the PM must ask the user now (one per ask-user finding).'),
  verdict: z.enum(['pass', 'fail', 'needs-full-review']).describe('pass only when every finding is user-said or detail-within-authority and there is no error or exploration problem.'),
};
const Calibrator1ResultSchema = z.object(Calibrator1ResultShape);
export type Calibrator1Result = z.infer<typeof Calibrator1ResultSchema>;

// ---------------------------------------------------------------- Calibrator ② (3.7)

export const Calibrator2CardSchema = z.object({
  ...commonCardFields,
  seat: z.literal('calibrator-2'),
  /** The detailed plan version and its review position. */
  target: z.string().min(1),
  review: z.literal('calibrator-2'),
  /** The PM plan version it is based on. */
  pmPlan: z.string().min(1),
  mode: Mode,
  /** Required: the PM plan's full text, the detailed plan's full text (old and new in a continuation), the provenance map, authorizations. */
  materials: z.array(Material).min(1),
  /** Elements of the detailed plan with their claimed provenance ("plan element X" or "architect"). */
  elements: z.array(Element).min(1),
  focus: z.array(z.string()).min(1),
  binding: Binding,
});
export type Calibrator2Card = z.infer<typeof Calibrator2CardSchema>;

export const Calibrator2ResultShape = {
  mappings: z
    .array(z.object({ element: z.string(), faithful: z.boolean().describe('Does it say what the plan element it maps to says, without distortion?'), reason: z.string() }))
    .describe('One per focus element that claims a PM plan element.'),
  supplements: z
    .array(
      z.object({
        element: z.string(),
        finding: z.enum(['detail', 'important-decision', 'contradicts-user']).describe('detail: a detail the user would not care about; important-decision: changes what the user gets, hard to undo, or unclear whether it can be undone; contradicts-user.'),
        reason: z.string(),
      }),
    )
    .describe('One per focus element the Architect added.'),
  verdict: z.enum(['pass', 'escalate', 'needs-full-review']).describe('pass only when every mapping is faithful and every supplement is a detail. You never send the plan back yourself: anything else is "escalate".'),
  escalation: z.string().describe('For "escalate": what the Secretary must decide, in a few sentences. Empty otherwise.'),
};
const Calibrator2ResultSchema = z.object(Calibrator2ResultShape);
export type Calibrator2Result = z.infer<typeof Calibrator2ResultSchema>;

// ---------------------------------------------------------------- definitions

export const CALIBRATOR_1_DEFINITION = [
  'You are the Calibrator seat of a software pipeline, first position: you audit the direction of the PM plan against what the user actually said. You catch the PM filling in direction the user never gave. The card in the first message lists the plan elements to judge and the materials.',
  TOOLS_NOTE_MATERIALS,
  'For each focus element give one finding: "user-said" only when you found the user\'s words that say it (cite the material pages); "detail-within-authority" for a PM supplement that a recorded authorization covers; "ask-user" for an important design decision the user has not made (it changes what the user gets, it is hard to undo or you cannot tell whether it can be undone, or it conflicts with the user\'s words); "contradicts-user" when it goes against the user\'s words. An element marked "user said" whose words you cannot find counts as a PM supplement.',
  'Also report the five error kinds (made up, left out, distorted, a premise that does not hold, elements contradicting each other), and for each exploration whether its definition presets the answer and whether the plan goes past it before it stands. Put one question for the PM to ask the user for every "ask-user" finding.',
  'In a continuation review (the card says so) focus on the changes, but judge them against the whole plan: you have the old and the new full text. If you cannot judge how far a change reaches, answer verdict "needs-full-review" instead of guessing.',
  'Verdict: "pass" only when every finding is user-said or detail-within-authority and there is no error and no exploration problem; otherwise "fail". Call submit_result once, then end your turn.',
  'You see neither the PM\'s reasoning nor any progress of the work. Upstream: the PM, who records the plan with the user. Downstream: a pass goes to the Architect; a fail goes back to the PM with your reasons and questions.',
].join('\n\n');

export const CALIBRATOR_2_DEFINITION = [
  'You are the Calibrator seat of a software pipeline, second position: you audit the detailed plan the Architect derived from an approved PM plan. You check that what claims to come from a PM plan element says what that element says, and you classify everything the Architect added.',
  TOOLS_NOTE_MATERIALS,
  'For each focus element that claims a PM plan element: is it faithful (no narrowing, widening, reordering of a user-specified order, or changed meaning)? For each element the Architect added: "detail" (the user would not care), "important-decision" (it changes what the user gets, it is hard to undo, or you cannot tell whether it can be undone), or "contradicts-user".',
  'In a continuation review focus on the changes but judge them against the whole plan (you have both full texts). If you cannot judge how far a change reaches, answer "needs-full-review".',
  'Verdict: "pass" only when every mapping is faithful and every supplement is a detail; otherwise "escalate", with what the Secretary must decide. You never send the plan back to the Architect yourself. Call submit_result once, then end your turn.',
  'Upstream: the Architect (decomposition). Downstream: a pass releases the plan\'s tasks to the program; an escalation goes to the Secretary.',
].join('\n\n');

// ---------------------------------------------------------------- render

function renderElements(c: { elements: readonly z.infer<typeof Element>[]; focus: readonly string[] }): string {
  const focus = new Set(c.focus);
  return list(
    'Plan elements (judge the ones marked FOCUS)',
    c.elements.map((e) => `${focus.has(e.id) ? 'FOCUS ' : ''}[${e.id}] (${e.provenance}${e.mapsTo ? ` → plan element ${e.mapsTo}` : ''}) ${e.text}`),
  );
}

function renderMode(m: z.infer<typeof Mode>): string {
  return m.kind === 'full'
    ? '## Review\nA full review of the whole plan.\n\n'
    : `## Review\nA continuation of judgment ${m.extends}: focus on the changes of this batch, judged against the whole plan (both full texts are in the materials). Answer "needs-full-review" if you cannot judge how far a change reaches.\n\n`;
}

export function renderCalibrator1(c: Calibrator1Card): string {
  return (
    renderCommon(c) +
    `## Target\nPM plan version ${c.target} (review position: calibrator-1)\n\n` +
    renderMode(c.mode) +
    renderMaterials(c.materials) +
    renderElements(c) +
    list('Explorations the plan defines', c.explorations) +
    'When done, call submit_result with one finding per focus element, the errors, the exploration checks, the questions and one verdict; then end your turn.'
  );
}

export function renderCalibrator2(c: Calibrator2Card): string {
  return (
    renderCommon(c) +
    `## Target\nDetailed plan version ${c.target} (review position: calibrator-2), derived from PM plan version ${c.pmPlan}\n\n` +
    renderMode(c.mode) +
    renderMaterials(c.materials) +
    renderElements(c) +
    'When done, call submit_result with the mappings, the supplements and one verdict; then end your turn.'
  );
}

// ---------------------------------------------------------------- program rules

function onePerFocus(focus: readonly string[], judged: readonly string[], what: string): string[] {
  const out: string[] = [];
  for (const f of focus) {
    const n = judged.filter((j) => j === f).length;
    if (n === 0) out.push(`${what}: focus element "${f}" is not judged`);
    if (n > 1) out.push(`${what}: focus element "${f}" is judged ${n} times`);
  }
  for (const j of judged) if (!focus.includes(j)) out.push(`${what}: "${j}" is not a focus element`);
  return out;
}

export function calibrator1Problems(c: Calibrator1Card, r: Calibrator1Result, read: ReadonlySet<string> | undefined): string[] {
  const out = unreadMustRead(c.materials, read).map((k) => `must-read page ${k} was not read`);
  out.push(...onePerFocus(c.focus, r.elements.map((e) => e.element), 'elements'));
  const materials = new Set(c.materials.map((m) => m.id));
  const roleOf = (q: string): string | undefined => c.materials.find((m) => m.id === /^(.+)#\d+$/.exec(q)?.[1])?.role;
  for (const e of r.elements) {
    if (e.finding === 'user-said' && e.quotes.length === 0) out.push(`elements[${e.element}]: "user-said" needs the pages holding the user's words`);
    // the user's own words only: the PM's plan or items are not the user speaking (3.3; code review r1 #11)
    if (e.finding === 'user-said' && e.quotes.length > 0 && !e.quotes.every((q) => roleOf(q) === 'user-words')) out.push(`elements[${e.element}]: "user-said" cites only the user's words (materials marked as the user's words), not the plan or the items`);
    if (e.finding === 'detail-within-authority' && !e.quotes.some((q) => roleOf(q) === 'authorizations')) out.push(`elements[${e.element}]: "detail-within-authority" cites the authorization that covers it (an authorizations page)`);
    for (const q of e.quotes) {
      const m = /^(.+)#(\d+)$/.exec(q);
      if (m === null || !materials.has(m[1] as string)) out.push(`elements[${e.element}]: "${q}" is not a "<material>#<page>" pointer to a card material`);
      else {
        const mat = c.materials.find((x) => x.id === m[1]);
        if (mat !== undefined && (Number(m[2]) < 1 || Number(m[2]) > mat.pages)) out.push(`elements[${e.element}]: ${q} is past the material's ${mat.pages} pages`);
      }
    }
  }
  const ids = new Set(c.elements.map((e) => e.id));
  for (const err of r.errors) for (const el of err.elements) if (!ids.has(el)) out.push(`errors: "${el}" is not a plan element`);
  const explorations = new Set(c.explorations);
  for (const x of r.explorations) if (!explorations.has(x.exploration)) out.push(`explorations: "${x.exploration}" is not an exploration of the plan`);
  for (const x of c.explorations) if (!r.explorations.some((e) => e.exploration === x)) out.push(`explorations: exploration "${x}" is not checked`);
  const asks = r.elements.filter((e) => e.finding === 'ask-user').map((e) => e.element);
  for (const a of asks) if (!r.questions.some((q) => q.element === a)) out.push(`questions: element "${a}" is "ask-user" but has no question`);
  const clean = r.elements.every((e) => e.finding === 'user-said' || e.finding === 'detail-within-authority') && r.errors.length === 0 && r.explorations.every((x) => !x.presetAnswer && !x.jumpsAhead);
  if (r.verdict === 'pass' && !clean) out.push('verdict: "pass" leaves a finding, an error or an exploration problem');
  if (r.verdict === 'fail' && clean) out.push('verdict: "fail" without any finding, error or exploration problem');
  if (r.verdict === 'needs-full-review' && c.mode.kind === 'full') out.push('verdict: "needs-full-review" is only for a continuation review');
  return out;
}

export function calibrator2Problems(c: Calibrator2Card, r: Calibrator2Result, read: ReadonlySet<string> | undefined): string[] {
  const out = unreadMustRead(c.materials, read).map((k) => `must-read page ${k} was not read`);
  const byId = new Map(c.elements.map((e) => [e.id, e]));
  const focusMapped = c.focus.filter((f) => (byId.get(f)?.mapsTo ?? null) !== null);
  const focusAdded = c.focus.filter((f) => (byId.get(f)?.mapsTo ?? null) === null);
  out.push(...onePerFocus(focusMapped, r.mappings.map((m) => m.element), 'mappings'));
  out.push(...onePerFocus(focusAdded, r.supplements.map((s) => s.element), 'supplements'));
  const clean = r.mappings.every((m) => m.faithful) && r.supplements.every((s) => s.finding === 'detail');
  if (r.verdict === 'pass' && !clean) out.push('verdict: "pass" leaves an unfaithful mapping or a supplement that is not a detail');
  if (r.verdict === 'escalate' && clean) out.push('verdict: "escalate" without any unfaithful mapping or non-detail supplement');
  if (r.verdict === 'escalate' && r.escalation.trim() === '') out.push('escalation: say what the Secretary must decide');
  if (r.verdict === 'needs-full-review' && c.mode.kind === 'full') out.push('verdict: "needs-full-review" is only for a continuation review');
  return out;
}

// ---------------------------------------------------------------- records

/** The judgment a Calibrator verdict becomes (none for "needs-full-review": a full review follows). */
export function calibratorJudgment(c: { target: string; review: string; binding: CardBinding }, verdict: Verdict): JudgmentRecord {
  const b = c.binding;
  const rec: JudgmentRecord = {
    kind: 'judgment',
    judgment: b.judgment as JudgmentId,
    review: c.review,
    executor: 'calibrator',
    target: c.target as ObjectVersionId,
    verdict,
    evidence: (b.evidence ?? EMPTY_LIST) as ListRef,
    bases: b.bases as ListRef,
    constraints: b.constraints as ListRef,
    reliesOn: b.reliesOn as ListRef,
    issues: [],
    revokes: b.revokes as JudgmentId | null,
    evidenceUse: b.evidenceUse,
    superseded: b.superseded,
    extends: b.extends as JudgmentId | null,
  };
  validateRecord(rec);
  return rec;
}

/** The empty list's reference (JSON "[]"). */
export const EMPTY_LIST = { hash: '4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945', count: 0 } as const;

/** Calibrator ① verdicts: a clean plan passes; questions only (no contradiction or error) are "undecided"; otherwise negated. */
export function calibrator1Verdict(r: Calibrator1Result): Verdict | null {
  if (r.verdict === 'needs-full-review') return null;
  if (r.verdict === 'pass') return 'pass';
  const hard = r.errors.length > 0 || r.elements.some((e) => e.finding === 'contradicts-user') || r.explorations.some((x) => x.presetAnswer || x.jumpsAhead);
  return hard ? 'fail' : 'undecided';
}

export function calibrator2Verdict(r: Calibrator2Result): Verdict | null {
  if (r.verdict === 'needs-full-review') return null;
  return r.verdict === 'pass' ? 'pass' : 'fail';
}

const calibrator1Entry: SeatCardEntry<Calibrator1Card, Calibrator1Result> = {
  kind: 'calibrator-1',
  seat: 'calibrator',
  schema: Calibrator1CardSchema,
  resultShape: Calibrator1ResultShape,
  resultSchema: Calibrator1ResultSchema,
  definition: CALIBRATOR_1_DEFINITION,
  toolProfile: 'materials',
  render: renderCalibrator1,
  problems: (c, r, ctx) => calibrator1Problems(c, r, ctx.materialsRead),
  records: (c, r) => {
    const v = calibrator1Verdict(r);
    return v === null ? [] : [calibratorJudgment(c, v)];
  },
};

const calibrator2Entry: SeatCardEntry<Calibrator2Card, Calibrator2Result> = {
  kind: 'calibrator-2',
  seat: 'calibrator',
  schema: Calibrator2CardSchema,
  resultShape: Calibrator2ResultShape,
  resultSchema: Calibrator2ResultSchema,
  definition: CALIBRATOR_2_DEFINITION,
  toolProfile: 'materials',
  render: renderCalibrator2,
  problems: (c, r, ctx) => calibrator2Problems(c, r, ctx.materialsRead),
  records: (c, r) => {
    const v = calibrator2Verdict(r);
    return v === null ? [] : [calibratorJudgment(c, v)];
  },
};

registerSeatCard(calibrator1Entry);
registerSeatCard(calibrator2Entry);
