// The Crititor seat (design 2, 4.3, 8.2): the exploration's attacker. Read-only and adversarial:
// it attacks one version of the exploration's product, re-checks every earlier finding the
// author disposed of (revised, or rebutted with an evidence execution), and may ask for an
// evidence execution itself (async, 6.2). It hands back findings (severity, basis, consequence,
// direction), one re-check per finding awaiting it, and the directions that need no further
// change. In a discussion turn (4.3 step 1) it answers the author's framing instead.
//
// This module also holds the exploration pieces the author cards share (src/seat/cards/
// researcher.ts): severities, finding and evidence items, the exploration reference, the new
// version binding, and attackOutcome(), the one rule that turns a round into a verdict (the
// program's rule, also used by the exploration flow to decide convergence, 8.2).
//
// Records (5.2, 10.1 "Crititor 攻击与裁决"): the round is a judgment on the review position
// (attacked version, 'crititor'), bound by the card's contract inputs (the exploration
// definition's version); each new finding is an issue record (5.6) observed on the version,
// its words a document in the content store; each re-check is the judgment's response to that
// issue (fixed / not-fixed).

import { z } from 'zod';
import type { IssueId, JudgmentId, ModuleId, ObjectVersionId } from '../../common/ids.ts';
import type { BaseRecord, IssueRecord, JudgmentRecord, ListRef } from '../../common/records.ts';
import { validateRecord } from '../../common/validate.ts';
import { Binding, Material, ReadOnlyWorkspace, commonCardFields, list, renderCommon, renderMaterials, TOOLS_NOTE_SNAPSHOT } from './common.ts';
import { registerSeatCard, type CardRecordContext, type SeatCardEntry } from './registry.ts';

// ---------------------------------------------------------------- shared exploration pieces

export const SEVERITIES = ['fatal', 'serious', 'general', 'minor'] as const;
export type Severity = (typeof SEVERITIES)[number];
/** Fatal and serious findings block convergence (8.2); general and minor ones do not. */
export const isBlocking = (s: Severity): boolean => s === 'fatal' || s === 'serious';

/** The default attack scope (4.3), extended or narrowed per product type by the definition. */
export const DEFAULT_ATTACK_SCOPE: readonly string[] = [
  'internal contradiction',
  'cannot be implemented',
  'gets stuck (deadlock, a wait that never ends)',
  'silently leaves an error behind',
  'cost out of control',
  "conflicts with the user's words",
];

/** Which exploration a card belongs to, and what the attack focuses on (4.3 research: method first, reasoning later). */
export const ExplorationRef = z.object({
  id: z.string().min(1),
  product: z.enum(['design', 'method', 'analysis', 'answer']),
  research: z.boolean(),
  focus: z.enum(['product', 'method', 'reasoning']),
  /** Research explorations: the question answered. */
  question: z.string().nullable(),
});
export type ExplorationRefT = z.infer<typeof ExplorationRef>;

export const DispositionAction = z.enum(['revise', 'rebut', 'escalate']);
export type DispositionActionT = z.infer<typeof DispositionAction>;

/** An earlier finding as a card shows it (to dispose of, to re-check, or for context). */
export const PriorFinding = z.object({
  /** The issue id of the finding (5.6). */
  id: z.string().min(1),
  severity: z.enum(SEVERITIES),
  class: z.string().min(1),
  title: z.string().min(1),
  round: z.number().int().positive(),
  /** The material holding the finding's full words (basis, consequence, direction), when on the card. */
  material: z.string().nullable(),
  /**
   * open: needs the author's disposition; awaiting-recheck: revised or rebutted, the attacker
   * re-checks it this round; awaiting-ruling: escalated as a direction question; resolved.
   */
  status: z.enum(['open', 'awaiting-recheck', 'awaiting-ruling', 'resolved']),
  disposition: z.object({ action: DispositionAction, note: z.string(), evidence: z.string().nullable(), question: z.string().nullable() }).nullable(),
  /** The decision layer's ruling on it, verbatim, if any. */
  ruling: z.string().nullable(),
});
export type PriorFindingT = z.infer<typeof PriorFinding>;

/** An evidence execution of this exploration, as a card shows it (cite it by id). */
export const EvidenceItem = z.object({
  id: z.string().min(1),
  /** unverified: a claim of the run rests on no record the program holds (review r1 #20): it refutes nothing. */
  status: z.enum(['completed', 'unverified', 'failed', 'not-run']),
  summary: z.string(),
  material: z.string().nullable(),
  /** Research explorations: the registered attempt it records. */
  attempt: z.string().nullable(),
});
export type EvidenceItemT = z.infer<typeof EvidenceItem>;

export const DiscussionEntry = z.object({ from: z.enum(['author', 'attacker']), round: z.number().int().nonnegative(), text: z.string() });

export const ReviewContractSchema = z.object({ review: z.string().min(1), basisLines: z.array(z.string()), reliesOn: z.array(z.string()) });

/** How the program makes the object version of a new product version (5.1, 10.1). */
export const NewVersion = z.object({
  /** The version id is `${prefix}.${first 16 hex of the content hash}`. */
  prefix: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:@-]{0,150}$/),
  objectKind: z.literal('interpretation'),
  scope: z.object({ paths: z.array(z.string().min(1)).min(1), taskType: z.string().min(1) }),
  reviews: z.array(ReviewContractSchema).min(1),
  predecessor: z.string().nullable(),
  /** Required prerequisite objects (5.3): a research interpretation rests on its method version (review r1 #2). */
  prerequisites: z.array(z.string()),
});
export type NewVersionT = z.infer<typeof NewVersion>;

export function versionId(nv: NewVersionT, content: string): string {
  return `${nv.prefix}.${content.slice(0, 16)}`;
}

/** The object version record of a new product version (its content is already in the store). */
export function versionRecord(card: { mission: string; module: string | null; newVersion: NewVersionT }, content: string, ctx: CardRecordContext): BaseRecord {
  const nv = card.newVersion;
  const rec: BaseRecord = {
    kind: 'object.version',
    object: versionId(nv, content) as ObjectVersionId,
    objectKind: nv.objectKind,
    mission: card.mission as never,
    module: card.module as ModuleId | null,
    content: content as never,
    prerequisites: ctx.content.putList([...nv.prerequisites]) as ListRef,
    scope: { paths: nv.scope.paths, taskType: nv.scope.taskType },
    reviews: nv.reviews.map((r) => ({ review: r.review, basisLines: r.basisLines as never, reliesOn: r.reliesOn as never })),
    ...(nv.predecessor !== null ? { predecessor: nv.predecessor as ObjectVersionId } : {}),
  };
  validateRecord(rec);
  return rec;
}

export function renderPriorFindings(title: string, findings: readonly PriorFindingT[]): string {
  return list(
    title,
    findings.map((f) => {
      const d = f.disposition;
      const disp = d === null ? '' : ` — author: ${d.action}${d.evidence !== null ? ` (evidence:${d.evidence})` : ''}${d.note !== '' ? `: ${d.note}` : ''}${d.question !== null ? ` [question: ${d.question}]` : ''}`;
      return `[${f.id}] (${f.severity}, ${f.class}, round ${f.round}, ${f.status}) ${f.title}${f.material !== null ? ` (full text: material ${f.material})` : ''}${disp}${f.ruling !== null ? ` — ruling: ${f.ruling}` : ''}`;
    }),
  );
}

export function renderEvidence(items: readonly EvidenceItemT[]): string {
  return list(
    'Evidence executions of this exploration (cite as evidence:<id>)',
    items.map((e) => `[${e.id}] ${e.status}${e.attempt !== null ? ` (attempt ${e.attempt})` : ''}: ${e.summary}${e.material !== null ? ` (record: material ${e.material})` : ''}`),
  );
}

export function renderExploration(x: ExplorationRefT, goal: string, scope: readonly string[]): string {
  return (
    `## Exploration ${x.id}\nProduct: ${x.product}${x.research ? ' (research exploration)' : ''}; this round's focus: ${x.focus}.\n` +
    (x.question !== null ? `Question: ${x.question}\n` : '') +
    `\n## The user's acceptance goal (verbatim)\n${goal}\n\n` +
    list('Attack scope (what counts as a hole)', scope)
  );
}

// ---------------------------------------------------------------- the card

export const CrititorCardSchema = z.object({
  ...commonCardFields,
  seat: z.literal('crititor'),
  workspace: ReadOnlyWorkspace,
  exploration: ExplorationRef,
  /** Required: the user's fuzzy acceptance goal, verbatim (4.3). */
  goal: z.string().min(1),
  /** Required: what counts as a hole (4.3). */
  attackScope: z.array(z.string().min(1)).min(1),
  mode: z.enum(['attack', 'discuss']),
  /** The closing attacker: a new session, a fresh view (4.3 连续性). */
  fresh: z.boolean(),
  round: z.number().int().positive(),
  /** attack: the version attacked (required); discuss: the current version, if any. */
  target: z.string().nullable(),
  review: z.literal('crititor'),
  /** The version before the target, when the target revises one (its full text is a material). */
  previousTarget: z.string().nullable(),
  priorFindings: z.array(PriorFinding),
  evidence: z.array(EvidenceItem),
  discussion: z.array(DiscussionEntry),
  rulings: z.array(z.string()),
  materials: z.array(Material),
  /** attack: the judgment's binding inputs, fixed by the contract (5.2); null in a discussion. */
  binding: Binding.nullable(),
  /**
   * Evidence the version's standing rests on, whatever this round cites (review r1 #2): the runs
   * that rebutted resolved findings, and for a research interpretation every record it cites.
   * The judgment requires them, so revoking one takes the proof away (5.2).
   */
  requiredEvidence: z.array(z.string()),
});
export type CrititorCard = z.infer<typeof CrititorCardSchema>;

const NewFinding = z.object({
  severity: z.enum(SEVERITIES),
  class: z.string().min(1).describe('One entry of the attack scope, or a short name of another kind of hole.'),
  title: z.string().min(1).describe('One line.'),
  basis: z.string().min(1).describe('Why this is a real problem: the passage, the counterexample, evidence:<id> or file:<path>:<line>.'),
  consequence: z.string().min(1).describe('What goes wrong if it stays.'),
  direction: z.string().min(1).describe('Which way a fix should go.'),
  evidence: z.array(z.string()).describe('Evidence ids of this exploration supporting the finding (may be empty).'),
});

export const CrititorResultShape = {
  findings: z.array(NewFinding).describe('New findings on the attacked version (attack mode). Empty when you found nothing real.'),
  rechecks: z
    .array(
      z.object({
        finding: z.string().describe('The id of an earlier finding marked awaiting-recheck.'),
        resolved: z.enum(['yes', 'no']).describe('revise: is it really fixed in this version? rebut: does the evidence execution really cover the original counterexample?'),
        reason: z.string().min(1),
        evidence: z.array(z.string()).describe('Evidence ids you relied on (may be empty).'),
      }),
    )
    .describe('Exactly one re-check per earlier finding marked awaiting-recheck (attack mode).'),
  settled: z.array(z.string()).describe('Directions that need no further change.'),
  reply: z.string().describe('discuss mode: your answer to the framing; attack mode: a short overall assessment.'),
};
const CrititorResultSchema = z.object(CrititorResultShape);
export type CrititorResult = z.infer<typeof CrititorResultSchema>;

// ---------------------------------------------------------------- the round's outcome (8.2)

export interface AttackOutcome {
  readonly verdict: 'pass' | 'fail' | 'undecided';
  /** Earlier findings confirmed resolved this round. */
  readonly resolved: readonly string[];
  /** Earlier findings re-checked and not resolved. */
  readonly notResolved: readonly string[];
  /** Fatal and serious findings still unresolved after this round (earlier ones and new ones by index "new:<i>"). */
  readonly unresolvedBlocking: readonly string[];
  /** Of those, the ones that only wait for a ruling of the decision layer. */
  readonly awaitingRuling: readonly string[];
  readonly newBlocking: number;
}

/**
 * The program's rule (8.2): a round passes when no fatal or serious finding is unresolved after
 * it (new ones, and earlier ones not confirmed resolved by a re-check this round or by a
 * ruling); it is undecided when the only ones left wait for a ruling; otherwise it fails.
 */
export function attackOutcome(priorFindings: readonly PriorFindingT[], r: Pick<CrititorResult, 'findings' | 'rechecks'>): AttackOutcome {
  const yes = new Set(r.rechecks.filter((x) => x.resolved === 'yes').map((x) => x.finding));
  const no = new Set(r.rechecks.filter((x) => x.resolved === 'no').map((x) => x.finding));
  const unresolved: string[] = [];
  const awaiting: string[] = [];
  for (const f of priorFindings) {
    if (!isBlocking(f.severity) || f.status === 'resolved' || yes.has(f.id)) continue;
    unresolved.push(f.id);
    if (f.status === 'awaiting-ruling') awaiting.push(f.id);
  }
  r.findings.forEach((f, i) => {
    if (isBlocking(f.severity)) unresolved.push(`new:${i}`);
  });
  const newBlocking = r.findings.filter((f) => isBlocking(f.severity)).length;
  const verdict = unresolved.length === 0 ? 'pass' : unresolved.length === awaiting.length ? 'undecided' : 'fail';
  return { verdict, resolved: [...yes], notResolved: [...no], unresolvedBlocking: unresolved, awaitingRuling: awaiting, newBlocking };
}

// ---------------------------------------------------------------- program rules

function crititorProblems(card: CrititorCard, r: CrititorResult): string[] {
  const out: string[] = [];
  const evidenceIds = new Set(card.evidence.map((e) => e.id));
  if (card.mode === 'discuss') {
    if (r.reply.trim() === '') out.push('reply: answer the framing (this is a discussion turn)');
    if (r.findings.length > 0) out.push('findings: a discussion turn has no findings; put objections in the reply');
    if (r.rechecks.length > 0) out.push('rechecks: a discussion turn re-checks nothing');
    return out;
  }
  const due = card.priorFindings.filter((f) => f.status === 'awaiting-recheck').map((f) => f.id);
  for (const id of due) {
    const n = r.rechecks.filter((x) => x.finding === id).length;
    if (n === 0) out.push(`rechecks: finding "${id}" awaits your re-check`);
    if (n > 1) out.push(`rechecks: finding "${id}" is re-checked ${n} times`);
  }
  for (const x of r.rechecks) {
    if (!due.includes(x.finding)) out.push(`rechecks: "${x.finding}" is not a finding awaiting re-check on the card`);
    for (const e of x.evidence) if (!evidenceIds.has(e)) out.push(`rechecks[${x.finding}]: evidence "${e}" is not an evidence execution on the card`);
  }
  r.findings.forEach((f, i) => {
    for (const k of ['title', 'basis', 'consequence', 'direction'] as const) if (f[k].trim() === '') out.push(`findings[${i}].${k}: required`);
    for (const e of f.evidence) if (!evidenceIds.has(e)) out.push(`findings[${i}]: evidence "${e}" is not an evidence execution on the card`);
  });
  return out;
}

// ---------------------------------------------------------------- records

/** The document a new finding's words become; its hash names the issue (`finding:<hash>`). */
export function crititorFindingDocument(card: CrititorCard, f: CrititorResult['findings'][number], launch: string): string {
  return JSON.stringify({
    format: 'mp4.exploration-finding.v1',
    exploration: card.exploration.id,
    round: card.round,
    launch,
    target: card.target,
    severity: f.severity,
    class: f.class,
    title: f.title,
    basis: f.basis,
    consequence: f.consequence,
    direction: f.direction,
    evidence: f.evidence,
  });
}

/** The issue ids of the round's new findings, in hand-back order (the flow reads them the same way). */
export function crititorFindingIds(card: CrititorCard, r: Pick<CrititorResult, 'findings'>, launch: string, put: (doc: string) => string): string[] {
  return r.findings.map((f) => `finding:${put(crititorFindingDocument(card, f, launch))}`);
}

/** The evidence the round's judgment requires: what the version rests on, plus what the round cited (each once). */
export function crititorEvidence(card: CrititorCard, r: CrititorResult): string[] {
  const cited = new Set([...card.requiredEvidence, ...r.rechecks.flatMap((x) => x.evidence), ...r.findings.flatMap((f) => f.evidence)]);
  const onCard = card.evidence.map((e) => e.id).filter((e) => cited.has(e));
  return [...onCard, ...card.requiredEvidence.filter((e) => !onCard.includes(e))];
}

function crititorRecords(card: CrititorCard, r: CrititorResult, ctx: CardRecordContext): BaseRecord[] {
  if (card.mode !== 'attack' || card.target === null || card.binding === null) return [];
  const b = card.binding;
  const target = card.target as ObjectVersionId;
  const out: BaseRecord[] = [];
  const ids = crititorFindingIds(card, r, ctx.launch, (d) => ctx.content.put(d));
  if (ids.length > 0) {
    const observedOn = ctx.content.putList([target]);
    r.findings.forEach((f, i) => {
      const text = ctx.content.put(crititorFindingDocument(card, f, ctx.launch));
      const rec: IssueRecord = { kind: 'issue', issue: ids[i] as IssueId, module: card.module as ModuleId | null, observedOn, text: text as never };
      validateRecord(rec);
      out.push(rec);
    });
  }
  const o = attackOutcome(card.priorFindings, r);
  const issueOf = new Set(card.priorFindings.map((f) => f.id));
  const evidence = ctx.content.putList(crititorEvidence(card, r));
  const j: JudgmentRecord = {
    kind: 'judgment',
    judgment: b.judgment as JudgmentId,
    review: 'crititor',
    executor: 'crititor',
    target,
    verdict: o.verdict,
    evidence: evidence as ListRef,
    bases: b.bases as ListRef,
    constraints: b.constraints as ListRef,
    reliesOn: b.reliesOn as ListRef,
    issues: r.rechecks.filter((x) => issueOf.has(x.finding)).map((x) => ({ issue: x.finding as IssueId, response: x.resolved === 'yes' ? 'fixed' : 'not-fixed' })),
    // a pass names the negation it revokes (8.1, 5.2); a fail or an undecided revokes nothing
    revokes: o.verdict === 'pass' ? (b.revokes as JudgmentId | null) : null,
    evidenceUse: b.evidenceUse,
    superseded: b.superseded,
    extends: null,
  };
  validateRecord(j);
  out.push(j);
  return out;
}

// ---------------------------------------------------------------- definition and card text

export const CRITITOR_DEFINITION = [
  'You are the Crititor seat of a software pipeline: the attacker of an exploration. An exploration is work whose acceptance cannot be written down in advance; it is accepted by surviving attack. The card in the first message names the exploration, the user\'s acceptance goal (verbatim), the attack scope, and the version you attack.',
  TOOLS_NOTE_SNAPSHOT,
  'What you do: attack the version, adversarially and read-only. Your goal is to find real problems, not to get the product through. Do not invent problems to fill a quota; say plainly when a direction needs no further change (settled). You may criticize a direction the maintainer set, but give the reason and the consequence.',
  'Card fields: exploration (required), goal (required, verbatim), attack scope (required), mode (attack or discuss), round, target version and the version before it (their full texts are materials), earlier findings with the author\'s dispositions, evidence executions, the discussion so far, rulings of the decision layer. "fresh" means you are the closing attacker: a new session that has not seen the earlier rounds\' conversation; attack with a fresh view.',
  'Hand-back (submit_result, once): attack mode: findings, each with severity (fatal, serious, general, minor), class, title, basis, consequence and direction; one re-check per earlier finding marked awaiting-recheck: for a revision, is it really fixed in this version; for a rebuttal, does the cited evidence execution really cover the original counterexample (yes or no, with the reason); settled directions; a short assessment. Discuss mode: your reply to the framing and attack scope, no findings. Then end your turn.',
  'Evidence: when a claim can only be settled by running or reading something, call request_evidence with the steps, the data, what to record and the assertions, written so that a blind executor can follow them. Your session ends and resumes with the results. You may also attack the steps of an evidence execution (for example a probe that prints but never fails).',
  'Prohibitions: you change nothing; you do not judge whether the product "should pass"; you do not repeat a finding already resolved unless it came back.',
  'Upstream: the Researcher who authors the product. Downstream: the Researcher, who disposes of every finding; when the exploration converges or stops, the decision layer.',
  'Your tools: read_file, list_directory, search_content, read_material (the card\'s materials), request_evidence, submit_result.',
].join('\n\n');

export function renderCrititorCard(c: CrititorCard): string {
  return (
    renderCommon(c) +
    renderExploration(c.exploration, c.goal, c.attackScope) +
    (c.fresh ? '## You are the closing attacker\nA new session with a fresh view: you have not seen the earlier conversation. Attack the version as if for the first time, and re-check what is listed.\n\n' : '') +
    (c.mode === 'attack'
      ? `## Round ${c.round}: attack version ${c.target ?? '(none)'}\n${c.previousTarget !== null ? `It revises ${c.previousTarget}; both full texts are materials.\n` : ''}\n`
      : `## Round ${c.round}: discussion\nThe author asks to align the framing and the attack scope before (or while) the product takes shape. Answer in the reply.\n\n`) +
    renderPriorFindings('Earlier findings (re-check every one marked awaiting-recheck)', c.priorFindings) +
    renderEvidence(c.evidence) +
    list('Discussion so far', c.discussion.map((d) => `(${d.from}, round ${d.round}) ${d.text}`)) +
    list('Rulings of the decision layer (verbatim)', c.rulings) +
    renderMaterials(c.materials) +
    'When done, call submit_result once, then end your turn.'
  );
}

export const crititorEntry: SeatCardEntry<CrititorCard, CrititorResult> = {
  kind: 'crititor',
  seat: 'crititor',
  schema: CrititorCardSchema,
  resultShape: CrititorResultShape,
  resultSchema: CrititorResultSchema,
  definition: CRITITOR_DEFINITION,
  toolProfile: 'read-evidence',
  render: renderCrititorCard,
  problems: (c, r) => crititorProblems(c, r),
  records: crititorRecords,
};

registerSeatCard(crititorEntry);
