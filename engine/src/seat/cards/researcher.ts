// The Researcher seat (design 2, 4.3, 8.2) has three cards, run by different instances:
//
//   researcher-author       the exploration's author: owns the product; each round it picks one
//                           step: discuss (align the framing with the attacker), evidence
//                           (request_evidence: an async evidence execution, 6.2) or submit (a
//                           new version, with a disposition for every open finding: revise,
//                           rebut with an evidence execution, or escalate as a direction
//                           question). In a research exploration its first product is the
//                           method with the attempt register (4.3 "开题").
//   researcher-reader       a blind reading investigation: steps, data, what to record and
//                           assertions; may use the network the card allows (fetch_url).
//   researcher-interpreter  research explorations: interprets the registered attempts' records
//                           without having taken part in any execution, and defends and revises
//                           that interpretation against the attack on its reasoning ("结题").
//
// Records: a submitted product version is an object version (5.1, kind "interpretation", its
// required review position "crititor" with the contract the card fixes); a reading run is an
// evidence record (src/seat/cards/experiment.ts).

import { z } from 'zod';
import { sha256 } from '../../common/hash.ts';
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
import { Material, ReadOnlyWorkspace, commonCardFields, list, renderCommon, renderMaterials, TOOLS_NOTE_SNAPSHOT } from './common.ts';
import { BlindResultShape, blindEvidenceRecord, blindFields, blindProblems, renderBlind, type BlindResult, type FetchedPage } from './experiment.ts';
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
  step: z.enum(['discuss', 'submit']).describe('discuss: align the framing first; submit: a new version for attack. (For evidence, call request_evidence instead.)'),
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
  return JSON.stringify({ format: 'mp4.research-method.v1', exploration: card.exploration.id, method: r.artifact, attempts: r.attempts });
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
    const seen = new Set<string>();
    for (const a of r.attempts) {
      if (seen.has(a.id)) out.push(`attempts: id "${a.id}" is registered twice`);
      seen.add(a.id);
      if (a.measure.length === 0 && a.assertions.length === 0) out.push(`attempts[${a.id}]: record at least one quantity or check one assertion`);
    }
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

export const AUTHOR_DEFINITION = [
  'You are the Researcher seat of a software pipeline, as the author of an exploration. An exploration is work whose acceptance cannot be written down in advance: it is accepted by surviving attack. You own the product (a design, a method, an analysis or an answer), produce it, revise it and defend it against an attacker (the Crititor), round by round.',
  TOOLS_NOTE_SNAPSHOT,
  'Each turn you pick one step. Discuss: when the product has not taken shape or the framing is unclear, align the framing and the attack scope with the attacker (step "discuss", your message). Evidence: when a claim must be settled by running or reading something, call request_evidence with the steps, data, quantities and assertions written for a blind executor (no expectation in them); your session ends and resumes with the results. Submit: hand back the full text of the new version (step "submit"), with one disposition per open finding: revise (accepted and changed in this version), rebut (refuted by an evidence execution you name), or escalate (a direction question for the user, through the Secretary).',
  'Card fields: exploration (required), goal (the user\'s words, required), attack scope (required), the decision served and its type, round and budget, the current version (a material), open findings (dispose of each), other findings, evidence executions, the discussion, rulings, materials. In a research exploration\'s method phase, a submission carries the attempt register: every experiment or reading you will rely on, registered before it runs.',
  'Hand-back (submit_result, once): step, message, artifact (the full text; empty keeps the current version), dispositions, direction questions, attempts (research method only). Then end your turn.',
  'Prohibitions: do not mark a finding "revise" without changing the version; do not rebut without an evidence execution; do not decide a direction question yourself; do not presuppose the answer in a research method.',
  'Upstream: the decision layer (the definition), the Crititor (findings), evidence executions. Downstream: the Crititor, who attacks each version you submit.',
  'Your tools: read_file, list_directory, search_content, read_material (the card\'s materials), request_evidence, submit_result.',
].join('\n\n');

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
    renderMaterials(c.materials) +
    'When done, call submit_result once (or request_evidence), then end your turn.'
  );
}

export const authorEntry: SeatCardEntry<AuthorCard, AuthorResult> = {
  kind: 'researcher-author',
  seat: 'researcher',
  schema: AuthorCardSchema,
  resultShape: AuthorResultShape,
  resultSchema: AuthorResultSchema,
  definition: AUTHOR_DEFINITION,
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
  /** The network the card allows (4.3 "阅读调查可按卡联网"): addresses fetch_url may read; empty: none. */
  network: z.object({ allowed: z.array(z.string().min(1)) }),
  ...blindFields,
});
export type ReaderCard = z.infer<typeof ReaderCardSchema>;

export const READER_DEFINITION = [
  'You are the Researcher seat of a software pipeline, on a blind reading card. You carry out one reading investigation exactly as the card\'s steps say and record what you found. You do not know, and must not guess, what anyone expects to find.',
  'Every capability you have is a program tool. You can read the project snapshot (paths relative to its root) and the card\'s materials; when the card allows addresses, fetch_url reads them (the program fetches; nothing else is reachable). Tool output is capped; a cut output says so.',
  'What you do: follow the steps in order; record each quantity the card names exactly once, and answer each assertion: holds, does not hold, or not checked. Every value and every answer cites the record it rests on: fetch:<k> for your k-th fetched page (counting from 1), or file:<path>[:<line>] for a file of the snapshot. The program checks these records; a claim without one does not count as evidence.',
  'Card fields: steps (required), data, quantities to record (required, may be empty only when there are assertions), assertions, allowed addresses, the evidence id, materials.',
  'Hand-back (submit_result, once): one entry per step, per quantity ("not obtained: <why>" when you could not) and per assertion, and your observations. Then end your turn.',
  'Prohibitions: do not interpret what the findings mean for any question; do not skip a step silently; do not read addresses the card does not allow.',
  'Upstream: the program, on behalf of the exploration that asked for the reading. Downstream: the program records your report as evidence; the exploration\'s author, attacker and interpreter read it.',
  'Your tools: read_file, list_directory, search_content, read_material, fetch_url, submit_result.',
].join('\n\n');

export function renderReaderCard(c: ReaderCard): string {
  return (
    renderCommon(c) +
    renderBlind(c) +
    list('Addresses you may read with fetch_url', c.network.allowed) +
    renderMaterials(c.materials) +
    'When done, call submit_result once with your report, then end your turn.'
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
  definition: READER_DEFINITION,
  toolProfile: 'read-web',
  render: renderReaderCard,
  problems: (c, r, ctx) => readerProblems(c, r, ctx.snapshot),
  // the host passes the pages it fetched (webFetches): fetch:<k> pointers are checked against them
  records: (c, r, ctx) => [blindEvidenceRecord(c, r, 'reading', { ...ctx, webFetches: (ctx as { webFetches?: readonly FetchedPage[] }).webFetches ?? [] })],
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
  return JSON.stringify({ format: 'mp4.research-interpretation.v1', exploration: card.exploration.id, method: card.method.version, answer: r.answer, conclusions: r.conclusions });
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

export const INTERPRETER_DEFINITION = [
  'You are the Researcher seat of a software pipeline, as the interpreter of a research exploration. A research exploration answers a question: its method and attempt register were attacked first; the registered experiments and readings were then run blind. You took part in none of that. You interpret the records, and defend and revise your interpretation against the attack on its reasoning.',
  TOOLS_NOTE_SNAPSHOT,
  'What you do: read the method, the register and every record (materials). Write the answer and its conclusions; each conclusion cites the records it rests on (attempt ids or evidence ids); every registered attempt\'s record is cited at least once, failed and unrun ones included. Mark a conclusion "not-standing" when the records do not carry it; when part of the key answer does not stand, say so: the exploration then has no conclusion, and that is an acceptable result.',
  'Card fields: exploration and question (required), goal (verbatim), attack scope, the method version, the attempt register with each record (required), other evidence, the current interpretation (when revising), open findings (dispose of each: revise, rebut with an evidence execution, or escalate), rulings, materials.',
  'Hand-back (submit_result, once): the answer, the conclusions (id, text, cites, standing, key), a message, and the dispositions. Then end your turn.',
  'Prohibitions: no conclusion without a record; do not drop an inconvenient record; do not run or ask for new evidence (raise the need in your message).',
  'Upstream: the program (the records of the registered attempts) and the Crititor (findings on the reasoning). Downstream: the Crititor attacks your interpretation; when it converges, the decision layer.',
  'Your tools: read_file, list_directory, search_content, read_material, submit_result.',
].join('\n\n');

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
    renderMaterials(c.materials) +
    'When done, call submit_result once, then end your turn.'
  );
}

export const interpreterEntry: SeatCardEntry<InterpreterCard, InterpreterResult> = {
  kind: 'researcher-interpreter',
  seat: 'researcher',
  schema: InterpreterCardSchema,
  resultShape: InterpreterResultShape,
  resultSchema: InterpreterResultSchema,
  definition: INTERPRETER_DEFINITION,
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
