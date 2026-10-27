// The Researcher seat (design 2, 4.3, 8.2) has three cards, run by different instances:
//
//   researcher-author       the exploration's author: owns the product; each round it picks one
//                           step: discuss (align the framing with the attacker), evidence
//                           (`mp seat <id> request-evidence`: an async evidence execution) or submit (a
//                           new version, with a disposition for every open finding: revise,
//                           rebut with an evidence execution, or escalate as a direction
//                           question). In a research exploration its first product is the
//                           method with the attempt register (4.3 "开题").
//   researcher-reader       a blind reading investigation: steps, data, what to record and
//                           assertions; reads the addresses the card allows with the harness's
//                           own tools and cites them as url:<address> (decision 12).
//   researcher-interpreter  research explorations: interprets the registered attempts' records
//                           without having taken part in any execution, and defends and revises
//                           that interpretation against the attack on its reasoning ("结题").
//
// Records: a submitted product version is an object version (5.1, kind "interpretation", its
// required review position "crititor" with the contract the card fixes); a reading run is an
// evidence record (src/seat/cards/experiment.ts).

import { z } from 'zod';
import { canonicalJson, sha256 } from '../../common/hash.ts';
import type { BaseRecord } from '../../common/records.ts';
import {
  DiscussionEntry,
  DispositionAction,
  EvidenceItem,
  ExplorationRef,
  NewVersion,
  PriorFinding,
  renderEvidence,
  renderExploration,
  renderPriorFindings,
  versionId,
  versionRecord,
  type PriorFindingT,
} from './crititor.ts';
import { Command, Material, ReadOnlyWorkspace, commonCardFields, list, renderCommon, renderMaterials } from './common.ts';
import { BlindResultShape, blindEvidenceRecord, blindFields, blindProblems, renderBlind, type BlindResult } from './experiment.ts';
import { registerSeatCard, type CardRecordContext, type SeatCardEntry } from './registry.ts';

const CurrentVersion = z.object({ version: z.string().min(1), content: z.string().regex(/^[0-9a-f]{64}$/), material: z.string().min(1) });

/** An attempt registered with a research method (8.2 尝试登记表). */
export const RegisteredAttempt = z.object({
  id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,60}$/).describe('A short id, unique in the register (e.g. "A1").'),
  kind: z.enum(['experiment', 'reading']),
  purpose: z.string().min(1).describe('What the attempt is for (shown to the attacker and the interpreter, never to the executor).'),
  steps: z.array(z.string().min(1)).min(1),
  data: z.string(),
  measure: z.array(z.string().min(1)),
  assertions: z.array(z.string().min(1)),
  commands: z.array(Command).optional().describe('experiment: the commands the steps run (the executor runs each with mp seat <id> rerun <command-id>).'),
});
export type RegisteredAttemptT = z.infer<typeof RegisteredAttempt>;

const Disposition = z.object({
  finding: z.string().describe('The id of an open finding on the card.'),
  action: DispositionAction.describe('revise: accepted and fixed in the version you submit; rebut: refuted by an evidence execution; escalate: a direction question for the decision layer.'),
  note: z.string().describe('What you changed, why the evidence refutes it, or the question in context.'),
  evidence: z.string().optional().describe('rebut: the evidence id that refutes the finding.'),
  question: z.string().optional().describe('escalate: the question for the decision layer.'),
});
export type DispositionT = z.infer<typeof Disposition>;

/** The program's rules on dispositions (8.2 程序检查): every open finding disposed of exactly once, rebuttals point to an evidence execution. */
export function dispositionProblems(open: readonly PriorFindingT[], ds: readonly DispositionT[], evidenceIds: ReadonlySet<string>, versionChanged: boolean): string[] {
  const out: string[] = [];
  const ids = open.map((f) => f.id);
  for (const id of ids) {
    const n = ds.filter((d) => d.finding === id).length;
    if (n === 0) out.push(`dispositions: open finding "${id}" has no disposition (revise, rebut or escalate)`);
    if (n > 1) out.push(`dispositions: finding "${id}" is disposed of ${n} times`);
  }
  for (const d of ds) {
    if (!ids.includes(d.finding)) out.push(`dispositions: "${d.finding}" is not an open finding on the card`);
    if (d.action === 'rebut' && (d.evidence === undefined || !evidenceIds.has(d.evidence))) out.push(`dispositions[${d.finding}]: a rebuttal names a completed evidence execution on the card (evidence; failed, unrun and unverified runs refute nothing)`);
    if (d.action === 'escalate' && (d.question === undefined || d.question.trim() === '')) out.push(`dispositions[${d.finding}]: an escalation states the question`);
    if (d.action === 'revise' && !versionChanged) out.push(`dispositions[${d.finding}]: "revise" needs a new version (the artifact you submit is unchanged)`);
  }
  return out;
}

// ---------------------------------------------------------------- researcher-author

export const AuthorCardSchema = z.object({
  ...commonCardFields,
  seat: z.literal('researcher-author'),
  workspace: ReadOnlyWorkspace,
  exploration: ExplorationRef,
  /** Required: the user's acceptance goal, verbatim (4.3). */
  goal: z.string().min(1),
  /** Required: the attack scope (4.3). */
  attackScope: z.array(z.string().min(1)).min(1),
  /** The decision the exploration serves and its type (3.10). */
  decision: z.object({ type: z.enum(['direction', 'structure']), text: z.string().min(1) }),
  round: z.number().int().nonnegative(),
  budgetRounds: z.number().int().positive(),
  /** The current version, or null before the first submission. */
  current: CurrentVersion.nullable(),
  /** Findings that need a disposition in a submission. */
  openFindings: z.array(PriorFinding),
  /** Other findings, for context (awaiting re-check or ruling, resolved). */
  otherFindings: z.array(PriorFinding),
  evidence: z.array(EvidenceItem),
  discussion: z.array(DiscussionEntry),
  rulings: z.array(z.string()),
  materials: z.array(Material),
  newVersion: NewVersion,
  /** Research method phase: a submission carries the attempt register (8.2). */
  registerAttempts: z.boolean(),
});
export type AuthorCard = z.infer<typeof AuthorCardSchema>;

export const AuthorResultShape = {
  step: z.enum(['discuss', 'submit']).describe('discuss: align the framing first; submit: a new version for attack. (For evidence, run mp seat <id> request-evidence instead.)'),
  message: z.string().describe('discuss: your message to the attacker; submit: what changed in this version and why.'),
  artifact: z
    .string()
    .describe('submit: the FULL text of the version. An empty string keeps the current version unchanged (allowed only when no finding is disposed of as "revise").'),
  dispositions: z.array(Disposition).describe('submit: exactly one per open finding on the card.'),
  directionQuestions: z.array(z.string()).describe('Questions of direction for the user (asked through the Secretary).'),
  attempts: z.array(RegisteredAttempt).describe('Research method only: the attempt register. Empty otherwise.'),
};
const AuthorResultSchema = z.object(AuthorResultShape);
export type AuthorResult = z.infer<typeof AuthorResultSchema>;

/** The document a submission makes (null: the current version is kept). */
export function authorVersionDocument(card: AuthorCard, r: AuthorResult): string | null {
  if (r.step !== 'submit' || r.artifact === '') return null;
  if (!card.registerAttempts) return r.artifact;
  return researchMethodDocument(card.exploration.id, r.artifact, r.attempts);
}

/** A research method version's document: the method's text and its attempt register. */
export interface ResearchMethodDoc {
  readonly format: 'mp4.research-method.v1';
  readonly exploration: string;
  readonly method: string;
  readonly attempts: readonly RegisteredAttemptT[];
}

/** A research method version's document (the author's submission, or the user's amendment of it: `mp pm amend-attempts`). */
export function researchMethodDocument(exploration: string, method: string, attempts: readonly RegisteredAttemptT[]): string {
  // canonical: the same document whether built from the seat's hand-back or from the stored result (its key order differs)
  const doc: ResearchMethodDoc = { format: 'mp4.research-method.v1', exploration, method, attempts };
  return canonicalJson(doc);
}

/**
 * The program's rules on an attempt register (8.2), beyond each attempt's schema: ids unique, and
 * every attempt records a quantity or checks an assertion. The author's registration and the
 * user's amendment of a registered method (`mp pm amend-attempts`) both check them.
 */
export function registerProblems(attempts: readonly RegisteredAttemptT[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const a of attempts) {
    if (seen.has(a.id)) out.push(`attempts: id "${a.id}" is registered twice`);
    seen.add(a.id);
    if (a.measure.length === 0 && a.assertions.length === 0) out.push(`attempts[${a.id}]: record at least one quantity or check one assertion`);
  }
  return out;
}

function authorProblems(card: AuthorCard, r: AuthorResult, put: (doc: string) => string): string[] {
  const out: string[] = [];
  if (r.step === 'discuss') {
    if (r.message.trim() === '') out.push('message: a discussion turn needs your message to the attacker');
    if (r.dispositions.length > 0) out.push('dispositions: dispose of findings in a submission, not in a discussion turn');
    if (r.attempts.length > 0) out.push('attempts: register attempts with the method you submit');
    return out;
  }
  const doc = authorVersionDocument(card, r);
  if (doc === null && card.current === null) out.push('artifact: the first submission carries the full text');
  if (card.registerAttempts) {
    if (r.artifact === '') out.push('artifact: a research method is always submitted whole (with its register)');
    if (r.attempts.length === 0) out.push('attempts: a research method registers at least one attempt');
    out.push(...registerProblems(r.attempts));
  } else if (r.attempts.length > 0) out.push('attempts: only a research method registers attempts');
  const changed = doc !== null && (card.current === null || put(doc) !== card.current.content);
  out.push(...dispositionProblems(card.openFindings, r.dispositions, new Set(card.evidence.filter((e) => e.status === 'completed').map((e) => e.id)), changed));
  return out;
}

function authorRecords(card: AuthorCard, r: AuthorResult, ctx: CardRecordContext): BaseRecord[] {
  const doc = authorVersionDocument(card, r);
  if (doc === null) return [];
  const content = ctx.content.put(doc);
  if (card.current !== null && content === card.current.content) return [];
  return [versionRecord(card, content, ctx)];
}

/** The version a submission leaves current: the new one, or the card's current one. */
export function authorSubmittedVersion(card: AuthorCard, r: AuthorResult, put: (doc: string) => string): { readonly version: string; readonly content: string; readonly changed: boolean } | null {
  const doc = authorVersionDocument(card, r);
  if (doc === null) return card.current === null ? null : { version: card.current.version, content: card.current.content, changed: false };
  const content = put(doc);
  if (card.current !== null && content === card.current.content) return { version: card.current.version, content, changed: false };
  return { version: versionId(card.newVersion, content), content, changed: true };
}


export function renderAuthorCard(c: AuthorCard): string {
  return (
    renderCommon(c) +
    renderExploration(c.exploration, c.goal, c.attackScope) +
    `## The decision this serves (${c.decision.type})\n${c.decision.text}\n\n` +
    `## Round ${c.round + 1} of at most ${c.budgetRounds}\n` +
    (c.current !== null ? `Current version: ${c.current.version} (full text: material ${c.current.material}).\n\n` : 'No version yet: discuss the framing, ask for evidence, or submit the first version.\n\n') +
    (c.registerAttempts ? '## Research method\nSubmit the method with its attempt register (attempts): every experiment or reading the answer will rest on, with steps, data, quantities and assertions for a blind executor.\n\n' : '') +
    renderPriorFindings('Open findings (dispose of every one when you submit)', c.openFindings) +
    renderPriorFindings('Other findings (context)', c.otherFindings) +
    renderEvidence(c.evidence) +
    list('Discussion so far', c.discussion.map((d) => `(${d.from}, round ${d.round}) ${d.text}`)) +
    list('Rulings of the decision layer (verbatim)', c.rulings) +
    renderMaterials(c.materials)
  );
}

export const authorEntry: SeatCardEntry<AuthorCard, AuthorResult> = {
  kind: 'researcher-author',
  seat: 'researcher',
  schema: AuthorCardSchema,
  resultShape: AuthorResultShape,
  resultSchema: AuthorResultSchema,
  toolProfile: 'read-evidence',
  render: renderAuthorCard,
  problems: (c, r) => authorProblems(c, r, contentHashOf),
  records: authorRecords,
};

// ---------------------------------------------------------------- researcher-reader (blind reading investigation)

export const ReaderCardSchema = z.object({
  ...commonCardFields,
  seat: z.literal('researcher-reader'),
  workspace: ReadOnlyWorkspace,
  /** The addresses the card allows (4.3 "阅读调查可按卡联网"), read with the harness's own tools; empty: none. */
  network: z.object({ allowed: z.array(z.string().min(1)) }),
  ...blindFields,
});
export type ReaderCard = z.infer<typeof ReaderCardSchema>;


export function renderReaderCard(c: ReaderCard): string {
  return (
    renderCommon(c) +
    renderBlind(c) +
    list('Addresses you may read (with your own tools; cite as url:<address> with the passage)', c.network.allowed) +
    renderMaterials(c.materials)
  );
}

function readerProblems(card: ReaderCard, r: BlindResult, snapshot?: import('../results.ts').SnapshotFiles): string[] {
  const out = blindProblems(card, r, snapshot);
  if (card.measure.length === 0 && card.assertions.length === 0) out.push('card: a reading records at least one quantity or checks one assertion');
  return out;
}

export const readerEntry: SeatCardEntry<ReaderCard, BlindResult> = {
  kind: 'researcher-reader',
  seat: 'researcher',
  schema: ReaderCardSchema,
  resultShape: BlindResultShape,
  resultSchema: z.object(BlindResultShape),
  toolProfile: 'read-web',
  render: renderReaderCard,
  problems: (c, r, ctx) => readerProblems(c, r, ctx.snapshot),
  // url:<address> pointers are checked against the card's addresses at hand-back, never fetched by mp (decision 12)
  records: (c, r, ctx) => [blindEvidenceRecord(c, r, 'reading', ctx)],
};

// ---------------------------------------------------------------- researcher-interpreter (research explorations)

export const InterpreterCardSchema = z.object({
  ...commonCardFields,
  seat: z.literal('researcher-interpreter'),
  workspace: ReadOnlyWorkspace,
  exploration: ExplorationRef,
  goal: z.string().min(1),
  attackScope: z.array(z.string().min(1)).min(1),
  /** The method version that passed its attack (a material). */
  method: z.object({ version: z.string().min(1), material: z.string().min(1) }),
  /** Required: the attempt register with each attempt's record (8.2). */
  attempts: z
    .array(z.object({ id: z.string().min(1), kind: z.enum(['experiment', 'reading']), purpose: z.string(), evidence: z.string().nullable(), status: z.enum(['completed', 'unverified', 'failed', 'not-run']), summary: z.string(), material: z.string().nullable() }))
    .min(1),
  /** Evidence executions outside the register (asked for during the rounds). */
  evidence: z.array(EvidenceItem),
  round: z.number().int().nonnegative(),
  budgetRounds: z.number().int().positive(),
  current: CurrentVersion.nullable(),
  openFindings: z.array(PriorFinding),
  otherFindings: z.array(PriorFinding),
  rulings: z.array(z.string()),
  materials: z.array(Material),
  newVersion: NewVersion,
});
export type InterpreterCard = z.infer<typeof InterpreterCardSchema>;

export const InterpreterResultShape = {
  answer: z.string().min(1).describe('The answer to the question, as the records support it.'),
  conclusions: z
    .array(
      z.object({
        id: z.string().min(1),
        text: z.string().min(1),
        cites: z.array(z.string()).describe('Attempt ids or evidence ids this conclusion rests on (at least one).'),
        standing: z.enum(['standing', 'not-standing']).describe('"not-standing" when the records do not carry it.'),
        key: z.boolean().describe('Part of the key answer.'),
      }),
    )
    .describe('Every conclusion cites records; every registered attempt is cited by at least one conclusion.'),
  message: z.string().describe('What changed and why (revisions).'),
  dispositions: z.array(Disposition).describe('Exactly one per open finding on the card (revisions).'),
};
const InterpreterResultSchema = z.object(InterpreterResultShape);
export type InterpreterResult = z.infer<typeof InterpreterResultSchema>;

export function interpretationDocument(card: InterpreterCard, r: InterpreterResult): string {
  return canonicalJson({ format: 'mp4.research-interpretation.v1', exploration: card.exploration.id, method: card.method.version, answer: r.answer, conclusions: r.conclusions });
}

/** "没有结论" (8.2): a key conclusion does not stand. */
export function interpretationHasNoConclusion(r: Pick<InterpreterResult, 'conclusions'>): boolean {
  return r.conclusions.some((c) => c.key && c.standing === 'not-standing');
}

function interpreterProblems(card: InterpreterCard, r: InterpreterResult, put: (doc: string) => string): string[] {
  const out: string[] = [];
  const known = new Set<string>([...card.attempts.map((a) => a.id), ...card.attempts.flatMap((a) => (a.evidence !== null ? [a.evidence] : [])), ...card.evidence.map((e) => e.id)]);
  if (r.conclusions.length === 0) out.push('conclusions: at least one');
  const seen = new Set<string>();
  for (const c of r.conclusions) {
    if (seen.has(c.id)) out.push(`conclusions: id "${c.id}" twice`);
    seen.add(c.id);
    if (c.cites.length === 0) out.push(`conclusions[${c.id}]: cite at least one record (8.2: a conclusion must cite records)`);
    for (const x of c.cites) if (!known.has(x)) out.push(`conclusions[${c.id}]: "${x}" is neither a registered attempt nor an evidence execution on the card`);
  }
  const cited = new Set(r.conclusions.flatMap((c) => c.cites));
  for (const a of card.attempts) if (!cited.has(a.id) && (a.evidence === null || !cited.has(a.evidence))) out.push(`conclusions: registered attempt "${a.id}" is not cited (8.2: every registered attempt's record is cited)`);
  if (!r.conclusions.some((c) => c.key)) out.push('conclusions: mark the conclusions that make up the key answer (key)');
  const content = put(interpretationDocument(card, r));
  out.push(...dispositionProblems(card.openFindings, r.dispositions, new Set(card.evidence.filter((e) => e.status === 'completed').map((e) => e.id)), card.current === null || content !== card.current.content));
  return out;
}

function interpreterRecords(card: InterpreterCard, r: InterpreterResult, ctx: CardRecordContext): BaseRecord[] {
  const content = ctx.content.put(interpretationDocument(card, r));
  if (card.current !== null && content === card.current.content) return [];
  return [versionRecord(card, content, ctx)];
}


export function renderInterpreterCard(c: InterpreterCard): string {
  return (
    renderCommon(c) +
    renderExploration(c.exploration, c.goal, c.attackScope) +
    `## Method\nVersion ${c.method.version} (full text: material ${c.method.material}).\n\n` +
    list(
      'Attempt register and records (cite every one)',
      c.attempts.map((a) => `[${a.id}] ${a.kind}, ${a.status}${a.evidence !== null ? ` (evidence:${a.evidence})` : ''}: ${a.purpose} — ${a.summary}${a.material !== null ? ` (record: material ${a.material})` : ''}`),
    ) +
    renderEvidence(c.evidence) +
    `## Round ${c.round + 1} of at most ${c.budgetRounds}\n` +
    (c.current !== null ? `Current interpretation: ${c.current.version} (material ${c.current.material}).\n\n` : 'No interpretation yet: write the first one.\n\n') +
    renderPriorFindings('Open findings (dispose of every one)', c.openFindings) +
    renderPriorFindings('Other findings (context)', c.otherFindings) +
    list('Rulings of the decision layer (verbatim)', c.rulings) +
    renderMaterials(c.materials)
  );
}

export const interpreterEntry: SeatCardEntry<InterpreterCard, InterpreterResult> = {
  kind: 'researcher-interpreter',
  seat: 'researcher',
  schema: InterpreterCardSchema,
  resultShape: InterpreterResultShape,
  resultSchema: InterpreterResultSchema,
  toolProfile: 'read',
  render: renderInterpreterCard,
  problems: (c, r) => interpreterProblems(c, r, contentHashOf),
  records: interpreterRecords,
};

/** The content store's identity of a document (sha256 hex), for comparisons without storing. */
function contentHashOf(doc: string): string {
  return sha256(doc);
}

registerSeatCard(authorEntry);
registerSeatCard(readerEntry);
registerSeatCard(interpreterEntry);
