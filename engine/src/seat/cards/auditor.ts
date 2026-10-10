// The Auditor seat (design 2, 5.2 part 3, 10.1, 11.1): legalization, an independent unit started
// only when the user asks (through the PM). Read-only. Two cards, each run by a new instance:
//
//   auditor-node   one node of the lineage that is not fully proven: the Auditor fills the
//                  node's required review positions that are missing, undecided or not current,
//                  or (only coverage missing) adds the uncovered constraint paths as a
//                  continuation of the deciding judgment (5.2 v34). Bound by the position's
//                  contract like any judgment there; it can never revoke a negation (5.2).
//   auditor-chain  the whole chain, once every node is proven: does the endpoint honour the
//                  user's words, and does every seam hold? Its judgment is the position
//                  (chain-acceptance object, "auditor-chain"); the stamp depends on that object.
//
// Records: one judgment per position (executor "auditor"), bound by the card's binding (fixed by
// the position's contract), citing the evidence it used; findings become issue records (5.6).

import { posix } from 'node:path';
import { z } from 'zod';
import type { IssueId, JudgmentId, ModuleId, ObjectVersionId, ProofUnitId } from '../../common/ids.ts';
import type { BaseRecord, IssueRecord, JudgmentRecord, ListRef } from '../../common/records.ts';
import { validateRecord } from '../../common/validate.ts';
import type { SnapshotFiles } from '../results.ts';
import { Binding, Command, Item, Material, Workspace, commonCardFields, list, renderCommon, renderMaterials, TOOLS_NOTE_SNAPSHOT } from './common.ts';
import { registerSeatCard, type CardRecordContext, type CardResultContext, type SeatCardEntry } from './registry.ts';

/** A read-only workspace whose declared commands may write into scratch copies (as the Reviewer's). */
const AuditWorkspace = Workspace.extend({ writablePaths: z.array(z.string()).max(0, 'an Auditor has no writable paths; name scratch paths instead') });

/** A run the Auditor may cite (evidence:<id>): reusable closed runs, or the reruns of 7.3. */
const AuditEvidence = z.object({ id: z.string().min(1), command: z.string(), summary: z.string() });

// ---------------------------------------------------------------- pointers

const FILE_POINTER = /^file:([^\s:]+)(?::(\d+)(?:-(\d+))?)?$/;

/** Problems of one evidence pointer: "evidence:<id>" on the card, or "file:<path>[:a[-b]]" in the snapshot. */
export function auditPointerProblems(pointer: string, evidenceIds: ReadonlySet<string>, snapshot: SnapshotFiles | undefined): string[] {
  if (pointer.startsWith('evidence:')) return evidenceIds.has(pointer.slice('evidence:'.length)) ? [] : [`${pointer} is not a run on the card`];
  const m = FILE_POINTER.exec(pointer);
  if (m === null) return [`"${pointer}" is neither evidence:<id> nor file:<path>:<line>`];
  const path = m[1] as string;
  if (posix.isAbsolute(path) || posix.normalize(path) !== path || path === '..' || path.startsWith('../') || path.split('/').includes('.git')) return [`${pointer}: the path must be a normalized path inside the snapshot`];
  if (snapshot === undefined) return [];
  const lines = snapshot.lines(path);
  if (lines === null) return [`${pointer}: ${path} is not a file of the snapshot`];
  if (m[2] === undefined) return [];
  const a = Number(m[2]);
  const b = m[3] === undefined ? a : Number(m[3]);
  return a < 1 || b < a || b > lines ? [`${pointer}: the lines are not inside ${path} (${lines} lines)`] : [];
}

const citedEvidence = (pointers: readonly string[], cardOrder: readonly string[]): string[] => {
  const cited = new Set(pointers.filter((p) => p.startsWith('evidence:')).map((p) => p.slice('evidence:'.length)));
  return cardOrder.filter((e) => cited.has(e));
};

function findingRecords(target: string, module: string | null, findings: readonly string[], ctx: CardRecordContext, tag: Record<string, unknown>): IssueRecord[] {
  if (findings.length === 0) return [];
  const observedOn = ctx.content.putList([target]);
  return findings.map((text) => {
    const doc = ctx.content.put(JSON.stringify({ format: 'mp4.finding.v1', text, launch: ctx.launch, target, ...tag }));
    const rec: IssueRecord = { kind: 'issue', issue: `finding:${doc}` as IssueId, module: module as ModuleId | null, observedOn, text: doc as never };
    validateRecord(rec);
    return rec;
  });
}

function judgment(b: z.infer<typeof Binding>, review: string, target: string, verdict: 'pass' | 'fail' | 'undecided', evidence: ListRef): JudgmentRecord {
  const j: JudgmentRecord = {
    kind: 'judgment',
    judgment: b.judgment as JudgmentId,
    review,
    executor: 'auditor',
    target: target as ObjectVersionId | ProofUnitId,
    verdict,
    evidence,
    bases: b.bases as ListRef,
    constraints: b.constraints as ListRef,
    reliesOn: b.reliesOn as ListRef,
    issues: [],
    // an Auditor never revokes a negation (5.2)
    revokes: null,
    evidenceUse: b.evidenceUse,
    superseded: b.superseded,
    extends: b.extends as JudgmentId | null,
  };
  validateRecord(j);
  return j;
}

// ---------------------------------------------------------------- auditor-node

export const AuditPosition = z.object({
  review: z.string().min(1),
  /** Why the position is backfilled (5.2 part 3 eligibility). */
  reason: z.enum(['missing', 'undecided', 'not-current', 'coverage']),
  /** The contract's basis items with their current text (required inputs: every one is judged). */
  bases: z.array(Item).min(1),
  /** The object's object constraints (5.2 v34): full text, content version, the paths to review against it. */
  constraints: z.array(z.object({ id: z.string().min(1), version: z.string().min(1), text: z.string().min(1), paths: z.array(z.string()) })),
  /** The judgment's binding inputs (the contract, and for "coverage" the continued judgment's inputs merged). */
  binding: Binding,
  /** The judgment on the position before (not current, undecided, or the one a coverage backfill continues). */
  prior: z.string().nullable(),
  /** coverage: the continued judgment's evidence in force (5.2 part 5: inherited); empty otherwise. */
  inheritedEvidence: z.array(z.string()),
});
export type AuditPositionT = z.infer<typeof AuditPosition>;

export const AuditNodeCardSchema = z.object({
  ...commonCardFields,
  seat: z.literal('auditor-node'),
  workspace: AuditWorkspace,
  legalization: z.string().min(1),
  /** The node: an object version or a proof unit (judged and stamped as a whole, 5.3). */
  target: z.object({
    id: z.string().min(1),
    kind: z.enum(['object', 'unit']),
    objectKind: z.string().min(1),
    label: z.string().min(1),
    /** An old-engine boundary node (11.2): its archived evidence is among the materials. */
    boundary: z.boolean(),
    paths: z.array(z.string()),
  }),
  positions: z.array(AuditPosition).min(1),
  evidence: z.array(AuditEvidence),
  declaredCommands: z.array(Command),
  materials: z.array(Material),
});
export type AuditNodeCard = z.infer<typeof AuditNodeCardSchema>;

const Judged = z.object({
  basis: z.string().describe('A basis item id from the position.'),
  met: z.enum(['yes', 'no', 'unclear']),
  reason: z.string(),
  evidence: z.array(z.string()).describe('Pointers: "evidence:<id>" from the card, or "file:<path>:<line>".'),
});

export const AuditNodeResultShape = {
  positions: z
    .array(
      z.object({
        review: z.string().describe('A position (review kind) from the card.'),
        verdict: z.enum(['pass', 'fail', 'undecided']),
        items: z.array(Judged).describe('Exactly one judgment per basis item of the position.'),
        constraints: z.array(z.object({ constraint: z.string(), paths: z.array(z.string()).describe('The paths you reviewed against this constraint.') })).describe('Exactly one entry per constraint of the position.'),
      }),
    )
    .describe('Exactly one entry per position on the card.'),
  findings: z.array(z.string()).describe('Problems outside the bases (they become issue records).'),
  summary: z.string(),
};
const AuditNodeResultSchema = z.object(AuditNodeResultShape);
export type AuditNodeResult = z.infer<typeof AuditNodeResultSchema>;

function nodeProblems(card: AuditNodeCard, r: AuditNodeResult, ctx: CardResultContext): string[] {
  const out: string[] = [];
  const ev = new Set(card.evidence.map((e) => e.id));
  for (const p of card.positions) {
    const got = r.positions.filter((x) => x.review === p.review);
    if (got.length !== 1) {
      out.push(`positions: "${p.review}" is answered ${got.length} times (exactly once)`);
      continue;
    }
    const a = got[0] as AuditNodeResult['positions'][number];
    for (const b of p.bases) {
      const n = a.items.filter((i) => i.basis === b.id).length;
      if (n !== 1) out.push(`positions[${p.review}]: basis "${b.id}" is judged ${n} times (exactly once)`);
    }
    for (const i of a.items) {
      if (!p.bases.some((b) => b.id === i.basis)) out.push(`positions[${p.review}]: "${i.basis}" is not a basis of the position`);
      if (i.reason.trim() === '') out.push(`positions[${p.review}][${i.basis}]: give the reason`);
      if (i.evidence.length === 0) out.push(`positions[${p.review}][${i.basis}]: cite at least one pointer`);
      for (const e of i.evidence) for (const x of auditPointerProblems(e, ev, ctx.snapshot)) out.push(`positions[${p.review}][${i.basis}]: ${x}`);
    }
    for (const k of p.constraints) {
      const c = a.constraints.filter((x) => x.constraint === k.id);
      if (c.length !== 1) {
        out.push(`positions[${p.review}]: constraint "${k.id}" is reported ${c.length} times (exactly once)`);
        continue;
      }
      const reviewed = new Set((c[0] as { paths: string[] }).paths);
      const missing = k.paths.filter((x) => !reviewed.has(x));
      if (a.verdict === 'pass' && missing.length > 0) out.push(`positions[${p.review}]: a pass reviews every path of constraint "${k.id}" (missing: ${missing.join(', ')})`);
    }
    if (a.verdict === 'pass' && a.items.some((i) => i.met !== 'yes')) out.push(`positions[${p.review}]: "pass" leaves a basis not met or unclear`);
  }
  for (const a of r.positions) if (!card.positions.some((p) => p.review === a.review)) out.push(`positions: "${a.review}" is not a position on the card`);
  return out;
}

function nodeRecords(card: AuditNodeCard, r: AuditNodeResult, ctx: CardRecordContext): BaseRecord[] {
  const order = card.evidence.map((e) => e.id);
  const out: BaseRecord[] = [];
  for (const p of card.positions) {
    const a = r.positions.find((x) => x.review === p.review);
    if (a === undefined) continue;
    const cited = citedEvidence(a.items.flatMap((i) => i.evidence), order);
    // a coverage continuation carries the continued judgment's evidence (5.2 part 5), plus what it cited
    const evidence = [...new Set([...p.inheritedEvidence, ...cited])];
    out.push(judgment(p.binding, p.review, card.target.id, a.verdict, ctx.content.putList(evidence)));
  }
  out.push(...findingRecords(card.target.id, card.module, r.findings, ctx, { legalization: card.legalization }));
  return out;
}

export const AUDITOR_NODE_DEFINITION = [
  'You are the Auditor seat of a software pipeline, legalizing one node of a lineage the user asked to have legalized. The node (an object version, or a proof unit judged as a whole) is not fully proven: some of its required review positions have no judgment, only an undecided one, a judgment that is no longer current, or lack review against a constraint. You fill exactly those positions, independently.',
  TOOLS_NOTE_SNAPSHOT,
  'What you do: for each position on the card, judge every basis item (the requirement items, standards and authorizations of the position\'s contract, current text) with pointers: "evidence:<id>" for a run listed on the card, "file:<path>:<line>" for what you read. Review every object constraint over the paths listed. A position marked "coverage" was already passed; review only the constraint paths listed, as an addition to that judgment. You may have the program rerun a declared command.',
  'Card fields: the node (required), the positions with their reasons, bases, constraints and prior judgments (required), runs you may cite, declared commands, materials (for an old-engine boundary node: the archived evidence).',
  'Hand-back (submit_result, once): one entry per position: a verdict (pass only when every basis is met and every constraint path was reviewed; fail; undecided when the bases themselves are unclear), one judgment per basis item, the paths reviewed per constraint; findings outside the bases; a summary. Then end your turn.',
  'Prohibitions: you change nothing; your judgment cannot overturn a negation and is not asked to; do not judge positions that are not on the card.',
  'Upstream: the user, through the PM (the legalization request). Downstream: the program records your judgments; when every node is proven, the chain Auditor.',
  'Your tools: read_file, list_directory, search_content, read_material, rerun_declared_command, submit_result.',
].join('\n\n');

export function renderAuditNodeCard(c: AuditNodeCard): string {
  return (
    renderCommon(c) +
    `## Legalization ${c.legalization}: node ${c.target.id}\n${c.target.kind === 'unit' ? 'A proof unit, judged as a whole.' : `A ${c.target.objectKind} version.`} Current label: ${c.target.label}.${c.target.boundary ? ' An old-engine boundary node: its archived evidence is among the materials.' : ''}\n\n` +
    list('Paths of the node', c.target.paths) +
    c.positions
      .map(
        (p) =>
          `## Position "${p.review}" (${p.reason}${p.prior !== null ? `; prior judgment ${p.prior}` : ''})\n` +
          (p.reason === 'coverage' ? 'Already passed: review only the constraint paths below, as an addition to that judgment.\n' : '') +
          `${p.bases.map((b) => `- [${b.id}] ${b.text}`).join('\n')}\n\n` +
          list('Object constraints (review every listed path)', p.constraints.map((k) => `[${k.id} @ ${k.version}] ${k.text} — paths: ${k.paths.join(', ') || '(none)'}`)),
      )
      .join('') +
    list('Runs you may cite (evidence:<id>)', c.evidence.map((e) => `[${e.id}] ${e.command}: ${e.summary}`)) +
    list('Commands you may have rerun', c.declaredCommands.map((d) => `[${d.id}] ${d.command}`)) +
    renderMaterials(c.materials) +
    'When done, call submit_result once, then end your turn.'
  );
}

export const auditNodeEntry: SeatCardEntry<AuditNodeCard, AuditNodeResult> = {
  kind: 'auditor-node',
  seat: 'auditor',
  schema: AuditNodeCardSchema,
  resultShape: AuditNodeResultShape,
  resultSchema: AuditNodeResultSchema,
  definition: AUDITOR_NODE_DEFINITION,
  toolProfile: 'read-rerun',
  render: renderAuditNodeCard,
  problems: nodeProblems,
  records: nodeRecords,
};

// ---------------------------------------------------------------- auditor-chain

/** Seams listed in the chain card's first message (5.5: within 8 KB); the complete table is a must-read material. */
export const SEAMS_ON_CARD = 30;

/** The complete seam table as a material document (every seam; review r1 #4: none may be dropped). */
export function seamTable(seams: ReadonlyArray<{ readonly id: string; readonly between: readonly string[]; readonly text: string }>): string {
  return seams.map((s) => `[${s.id}] ${s.between.join(' <-> ')}: ${s.text}`).join('\n');
}

export const AuditChainCardSchema = z.object({
  ...commonCardFields,
  seat: z.literal('auditor-chain'),
  workspace: AuditWorkspace,
  legalization: z.string().min(1),
  chain: z.object({
    /** The chain-acceptance object judged (10.1). */
    object: z.string().min(1),
    endpoint: z.string().min(1),
    nodes: z.array(z.object({ id: z.string().min(1), kind: z.string(), label: z.string() })).min(1),
    /** Branches left out because only reference edges lead there (11.1 部分合法化). */
    excluded: z.array(z.string()),
  }),
  /** Required: the user's words in force for the endpoint, verbatim (11.1 "兑现用户原话"). */
  quotes: z.array(Item).min(1),
  /** The seams to check: where two nodes of the chain meet (an interface, a call, a data format). */
  seams: z.array(z.object({ id: z.string().min(1), between: z.array(z.string()).min(2), text: z.string().min(1) })),
  evidence: z.array(AuditEvidence),
  declaredCommands: z.array(Command),
  materials: z.array(Material),
  binding: Binding,
});
export type AuditChainCard = z.infer<typeof AuditChainCardSchema>;

export const AuditChainResultShape = {
  quotes: z
    .array(z.object({ quote: z.string().describe('A quote id from the card.'), honored: z.enum(['yes', 'no', 'unclear']), reason: z.string(), evidence: z.array(z.string()) }))
    .describe('Exactly one per quote on the card.'),
  seams: z
    .array(z.object({ seam: z.string().describe('A seam id from the card.'), holds: z.enum(['yes', 'no', 'unclear']), reason: z.string(), evidence: z.array(z.string()) }))
    .describe('Exactly one per seam on the card.'),
  findings: z.array(z.string()).describe('Problems outside the quotes and seams (they become issue records).'),
  verdict: z.enum(['pass', 'fail', 'undecided']),
};
const AuditChainResultSchema = z.object(AuditChainResultShape);
export type AuditChainResult = z.infer<typeof AuditChainResultSchema>;

function chainProblems(card: AuditChainCard, r: AuditChainResult, ctx: CardResultContext): string[] {
  const out: string[] = [];
  if (card.seams.length > SEAMS_ON_CARD && !card.materials.some((m) => m.id === 'seams' && m.mustRead)) out.push('card: the complete seam table is missing (material "seams"); the chain cannot be judged');
  const ev = new Set(card.evidence.map((e) => e.id));
  for (const q of card.quotes) {
    const n = r.quotes.filter((x) => x.quote === q.id).length;
    if (n !== 1) out.push(`quotes: "${q.id}" is answered ${n} times (exactly once)`);
  }
  for (const s of card.seams) {
    const n = r.seams.filter((x) => x.seam === s.id).length;
    if (n !== 1) out.push(`seams: "${s.id}" is answered ${n} times (exactly once)`);
  }
  for (const x of r.quotes) {
    if (!card.quotes.some((q) => q.id === x.quote)) out.push(`quotes: "${x.quote}" is not a quote on the card`);
    if (x.reason.trim() === '') out.push(`quotes[${x.quote}]: give the reason`);
    if (x.evidence.length === 0) out.push(`quotes[${x.quote}]: cite at least one pointer`);
    for (const e of x.evidence) for (const p of auditPointerProblems(e, ev, ctx.snapshot)) out.push(`quotes[${x.quote}]: ${p}`);
  }
  for (const x of r.seams) {
    if (!card.seams.some((s) => s.id === x.seam)) out.push(`seams: "${x.seam}" is not a seam on the card`);
    if (x.reason.trim() === '') out.push(`seams[${x.seam}]: give the reason`);
    for (const e of x.evidence) for (const p of auditPointerProblems(e, ev, ctx.snapshot)) out.push(`seams[${x.seam}]: ${p}`);
  }
  if (r.verdict === 'pass' && (r.quotes.some((q) => q.honored !== 'yes') || r.seams.some((s) => s.holds !== 'yes'))) out.push('verdict: "pass" leaves a quote not honored or a seam not holding');
  return out;
}

function chainRecords(card: AuditChainCard, r: AuditChainResult, ctx: CardRecordContext): BaseRecord[] {
  const order = card.evidence.map((e) => e.id);
  const cited = citedEvidence([...r.quotes.flatMap((q) => q.evidence), ...r.seams.flatMap((s) => s.evidence)], order);
  return [
    judgment(card.binding, 'auditor-chain', card.chain.object, r.verdict, ctx.content.putList(cited)),
    ...findingRecords(card.chain.object, card.module, r.findings, ctx, { legalization: card.legalization }),
  ];
}

export const AUDITOR_CHAIN_DEFINITION = [
  'You are the Auditor seat of a software pipeline, judging a whole chain the user asked to have legalized. Every node of the chain is proven; you judge the chain-acceptance object: does the endpoint honour the user\'s words, and does every seam between the nodes hold?',
  TOOLS_NOTE_SNAPSHOT,
  'What you do: for each quote of the user (verbatim), judge whether the endpoint honours it; for each seam (where two nodes meet: an interface, a call, a data format), judge whether it holds; cite pointers ("evidence:<id>" for a run on the card, "file:<path>:<line>"). You may have the program rerun a declared command.',
  'Card fields: the chain (object, endpoint, nodes, excluded branches; required), the quotes (required), the seams, runs you may cite, declared commands, materials.',
  'Hand-back (submit_result, once): one entry per quote and per seam, findings outside them, and one verdict: pass only when every quote is honoured and every seam holds; fail; undecided when the words themselves are unclear. Then end your turn.',
  'Prohibitions: you change nothing; you do not re-judge the nodes (they are proven); a fail of yours is not overturned by another Auditor: the user\'s next legalization makes a new chain object.',
  'Upstream: the program, after every node Auditor of this legalization. Downstream: the program stamps the chain when your judgment passes; the result goes to the user through the PM.',
  'Your tools: read_file, list_directory, search_content, read_material, rerun_declared_command, submit_result.',
].join('\n\n');

export function renderAuditChainCard(c: AuditChainCard): string {
  return (
    renderCommon(c) +
    `## Legalization ${c.legalization}: chain ${c.chain.object}\nEndpoint: ${c.chain.endpoint}.\n\n` +
    list('Nodes of the chain (all proven)', c.chain.nodes.map((n) => `${n.id} (${n.kind}, ${n.label})`)) +
    list('Excluded branches (reached only through reference edges)', c.chain.excluded) +
    list("The user's words (judge every one)", c.quotes.map((q) => `[${q.id}] ${q.text}`)) +
    list(
      c.seams.length > SEAMS_ON_CARD ? `Seams (judge every one: ${c.seams.length} in all; the first ${SEAMS_ON_CARD} here, the complete table is the must-read material "seams")` : 'Seams (judge every one)',
      c.seams.slice(0, SEAMS_ON_CARD).map((s) => `[${s.id}] ${s.between.join(' <-> ')}: ${s.text}`),
    ) +
    list('Runs you may cite (evidence:<id>)', c.evidence.map((e) => `[${e.id}] ${e.command}: ${e.summary}`)) +
    list('Commands you may have rerun', c.declaredCommands.map((d) => `[${d.id}] ${d.command}`)) +
    renderMaterials(c.materials) +
    'When done, call submit_result once, then end your turn.'
  );
}

export const auditChainEntry: SeatCardEntry<AuditChainCard, AuditChainResult> = {
  kind: 'auditor-chain',
  seat: 'auditor',
  schema: AuditChainCardSchema,
  resultShape: AuditChainResultShape,
  resultSchema: AuditChainResultSchema,
  definition: AUDITOR_CHAIN_DEFINITION,
  toolProfile: 'read-rerun',
  render: renderAuditChainCard,
  problems: chainProblems,
  records: chainRecords,
};

registerSeatCard(auditNodeEntry);
registerSeatCard(auditChainEntry);
