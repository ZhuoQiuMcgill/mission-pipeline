// Blind evidence executions (design 4.3 "证据执行", 6.2 async evidence, 8.2): the Constructor's
// blind-experiment card, and the pieces it shares with the Researcher's blind reading card
// (src/seat/cards/researcher.ts). The executor's card holds only the steps, the data, what to
// record and the assertions, never the author's or the attacker's expectation (4.3). It hands
// back, step by step, what it did, the recorded quantities and whether each assertion held;
// the program records that as one evidence record (5.1 "探索的执行记录") whose full report is
// a document in the content store. A run that failed or never ran gets its record from the
// program instead (8.2: no measurement is required of a failed attempt).

import { z } from 'zod';
import type { EnvLineId, EnvSnapshotId, EvidenceId } from '../../common/ids.ts';
import type { BaseRecord, EvidenceRecord } from '../../common/records.ts';
import { validateRecord } from '../../common/validate.ts';
import { Material, Workspace, commonCardFields, list, renderCommon, renderMaterials, TOOLS_NOTE_SNAPSHOT } from './common.ts';
import type { SnapshotFiles } from '../results.ts';
import { registerSeatCard, type CardRecordContext, type SeatCardEntry } from './registry.ts';

/** The evidence record the program makes of the run (its environment line is the exploration's, 7.2). */
export const EvidenceBinding = z.object({
  id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:@-]{0,199}$/),
  envLine: z.string().min(1),
  envSnapshot: z.string().min(1),
  /** Research explorations: the registered attempt this run records (8.2 尝试登记表). */
  attempt: z.string().nullable(),
});
export type EvidenceBindingT = z.infer<typeof EvidenceBinding>;

/** What a blind executor gets (4.3): steps, data, what to record, assertions. Nothing else. */
export const blindFields = {
  /** Required: the steps, in order. */
  steps: z.array(z.string().min(1)).min(1),
  /** The data the steps use (inline, or names of materials). */
  data: z.string(),
  /** Required: what to record (the quantities). May be empty only when there are assertions. */
  measure: z.array(z.string().min(1)),
  /** The assertions to check, each to be answered holds / does not hold / not checked. */
  assertions: z.array(z.string().min(1)),
  evidence: EvidenceBinding,
  materials: z.array(Material),
};

export const BlindResultShape = {
  steps: z
    .array(z.object({ step: z.number().int().positive().describe('1-based step number.'), done: z.enum(['yes', 'no', 'partly']), note: z.string() }))
    .describe('Exactly one entry per step on the card.'),
  measurements: z
    .array(
      z.object({
        measure: z.string().describe('A quantity named on the card, verbatim.'),
        value: z.string().describe('The recorded value, or "not obtained: <why>".'),
        source: z.string().describe('Where it came from, as pointers the program checks: run:<k> (your k-th run_command, from 1), fetch:<k> (your k-th fetched page, from 1), file:<path>[:<line>].'),
      }),
    )
    .describe('Exactly one entry per quantity on the card.'),
  assertions: z
    .array(
      z.object({
        assertion: z.number().int().positive().describe('1-based assertion number.'),
        holds: z.enum(['yes', 'no', 'not-checked']),
        basis: z.string().min(1).describe('For yes or no: the pointers it rests on (run:<k>, fetch:<k>, file:<path>[:<line>]) and why.'),
      }),
    )
    .describe('Exactly one entry per assertion on the card.'),
  observations: z.string().describe('Anything else you observed while following the steps (no interpretation of what it means).'),
};
const BlindResultSchema = z.object(BlindResultShape);
export type BlindResult = z.infer<typeof BlindResultSchema>;

type BlindCard = { readonly steps: readonly string[]; readonly data: string; readonly measure: readonly string[]; readonly assertions: readonly string[]; readonly evidence: EvidenceBindingT; readonly launch: string; readonly seat: string };

export function blindProblems(card: BlindCard, r: BlindResult, snapshot?: SnapshotFiles): string[] {
  const out: string[] = [];
  for (let i = 1; i <= card.steps.length; i++) {
    const n = r.steps.filter((s) => s.step === i).length;
    if (n !== 1) out.push(`steps: step ${i} is reported ${n} times (exactly once)`);
  }
  for (const s of r.steps) if (s.step > card.steps.length) out.push(`steps: there is no step ${s.step} on the card`);
  for (const m of card.measure) {
    const n = r.measurements.filter((x) => x.measure === m).length;
    if (n !== 1) out.push(`measurements: "${m}" is recorded ${n} times (exactly once; write "not obtained: <why>" when you could not)`);
  }
  for (const x of r.measurements) if (!card.measure.includes(x.measure)) out.push(`measurements: "${x.measure}" is not a quantity on the card`);
  for (let i = 1; i <= card.assertions.length; i++) {
    const n = r.assertions.filter((a) => a.assertion === i).length;
    if (n !== 1) out.push(`assertions: assertion ${i} is answered ${n} times (exactly once)`);
  }
  for (const a of r.assertions) if (a.assertion > card.assertions.length) out.push(`assertions: there is no assertion ${a.assertion} on the card`);
  // every claim names the program record it rests on (review r1 #20: no evidence without an execution behind it)
  const allowed = card.seat === 'researcher-reader' ? ['fetch', 'file'] : ['run', 'file'];
  const check = (where: string, text: string): void => {
    const ps = blindPointers(text);
    if (ps.length === 0) out.push(`${where}: cite the record it rests on (${allowed.map((a) => (a === 'file' ? 'file:<path>[:<line>]' : `${a}:<k>`)).join(', ')})`);
    for (const p of ps) {
      if (!allowed.includes(p.kind)) out.push(`${where}: ${p.text} is not a record this seat can make`);
      else if (p.kind === 'file' && snapshot !== undefined && snapshot.lines(p.path) === null) out.push(`${where}: ${p.text}: ${p.path} is not a file of the snapshot`);
    }
  };
  for (const x of r.measurements) if (!/^not obtained/i.test(x.value.trim())) check(`measurements[${x.measure}]`, x.source);
  for (const a of r.assertions) if (a.holds !== 'not-checked') check(`assertions[${a.assertion}]`, a.basis);
  return out;
}

export interface BlindPointer {
  readonly kind: 'run' | 'fetch' | 'file';
  readonly text: string;
  /** run, fetch: 1-based index. */
  readonly k: number;
  /** file: the path. */
  readonly path: string;
}

/** The record pointers in a source or basis text: run:<k>, fetch:<k>, file:<path>[:<a>[-<b>]]. */
export function blindPointers(text: string): BlindPointer[] {
  const out: BlindPointer[] = [];
  for (const m of text.matchAll(/\b(run|fetch):(\d+)\b|\bfile:([^\s:,;]+)(?::\d+(?:-\d+)?)?/g)) {
    if (m[1] !== undefined) out.push({ kind: m[1] as 'run' | 'fetch', text: m[0], k: Number(m[2]), path: '' });
    else out.push({ kind: 'file', text: m[0], k: 0, path: m[3] as string });
  }
  return out;
}

/**
 * Whether every claim of a blind hand-back rests on a record that exists (review r1 #20): run:<k>
 * must be the k-th run of the launch and have completed; fetch:<k> the k-th fetched page; file
 * pointers were checked against the snapshot at hand-back. Returns the claims that do not.
 */
export function unbackedClaims(r: BlindResult, records: { readonly runs: number | null; readonly runOk: (k: number) => boolean; readonly fetches: number | null }): string[] {
  const out: string[] = [];
  const ok = (p: BlindPointer): boolean =>
    p.kind === 'file' || (p.kind === 'run' && records.runs !== null && p.k >= 1 && p.k <= records.runs && records.runOk(p.k)) || (p.kind === 'fetch' && records.fetches !== null && p.k >= 1 && p.k <= records.fetches);
  for (const x of r.measurements) if (!/^not obtained/i.test(x.value.trim()) && !blindPointers(x.source).some(ok)) out.push(`measurement "${x.measure}" (${x.source.slice(0, 80)})`);
  for (const a of r.assertions) if (a.holds !== 'not-checked' && !blindPointers(a.basis).some(ok)) out.push(`assertion ${a.assertion} (${a.basis.slice(0, 80)})`);
  return out;
}

/** Field values are short (10.1 "只放小记录"); the whole report is a document. */
const short = (s: string): string => (s.length <= 200 ? s : `${s.slice(0, 197)}...`);

/** The report document of a blind run (its hash is the record's `report` field). */
export function blindReportDocument(card: BlindCard, r: BlindResult): string {
  // what was asked (so the attacker can judge whether the run covers the counterexample, 8.2) and what came back
  return JSON.stringify({
    format: 'mp4.blind-report.v1',
    launch: card.launch,
    executor: card.seat,
    evidence: card.evidence.id,
    attempt: card.evidence.attempt,
    asked: { steps: card.steps, data: card.data, measure: card.measure, assertions: card.assertions },
    result: r,
  });
}

/** A page a reading seat fetched (the host's fetch record, mp4.web-fetch.v1, is in the content store). */
export interface FetchedPage {
  readonly url: string;
  readonly finalUrl: string;
  readonly status: number;
  readonly record: string;
}

/** The program's record of a blind run (runClass "open": seat-performed, never reused or renewed, 7.3). */
export function blindEvidenceRecord(
  card: BlindCard,
  r: BlindResult,
  executor: 'experiment' | 'reading',
  ctx: Pick<CardRecordContext, 'content'> & { readonly webFetches?: readonly FetchedPage[] },
  runs: ReadonlyArray<{ readonly run: string; readonly status: string }> | null = null,
): EvidenceRecord {
  const pages = ctx.webFetches ?? [];
  const unbacked = unbackedClaims(r, { runs: runs?.length ?? null, runOk: (k) => runs?.[k - 1]?.status === 'completed', fetches: ctx.webFetches !== undefined ? pages.length : null });
  const doc = { ...(JSON.parse(blindReportDocument(card, r)) as object), ...(pages.length > 0 ? { fetched: pages.map((f) => ({ url: f.url, finalUrl: f.finalUrl, status: f.status, record: f.record })) } : {}), ...(runs !== null ? { runs } : {}), unbacked };
  // "completed" only when every claim rests on a record the program holds; else "unverified" (no rebuttal can rest on it)
  const fields: Record<string, string> = { status: unbacked.length === 0 ? 'completed' : 'unverified', executor, report: ctx.content.put(JSON.stringify(doc)) };
  if (unbacked.length > 0) fields['unbacked'] = String(unbacked.length);
  if (pages.length > 0) fields['fetches'] = String(pages.length);
  pages.slice(0, 20).forEach((f, i) => (fields[`fetch:${i + 1}`] = f.record));
  (runs ?? []).slice(0, 20).forEach((x, i) => (fields[`run:${i + 1}`] = `${x.run} ${x.status}`));
  if (card.evidence.attempt !== null) fields['attempt'] = card.evidence.attempt;
  for (const s of r.steps) fields[`step:${s.step}`] = s.done;
  for (const m of r.measurements) fields[`measure:${m.measure}`] = short(m.value);
  for (const a of r.assertions) fields[`assertion:${a.assertion}`] = a.holds;
  const rec: EvidenceRecord = {
    kind: 'evidence',
    evidence: card.evidence.id as EvidenceId,
    envLine: card.evidence.envLine as EnvLineId,
    envSnapshot: card.evidence.envSnapshot as EnvSnapshotId,
    runClass: 'open',
    fields,
  };
  validateRecord(rec);
  return rec;
}

/**
 * The record the program writes for an attempt that failed, was interrupted or never ran (8.2:
 * generated by the program; no measurement is asked of it).
 */
export function failedEvidenceRecord(b: EvidenceBindingT, status: 'failed' | 'not-run', reason: string, executor: 'experiment' | 'reading'): EvidenceRecord {
  const fields: Record<string, string> = { status, executor, reason: short(reason) };
  if (b.attempt !== null) fields['attempt'] = b.attempt;
  const rec: EvidenceRecord = { kind: 'evidence', evidence: b.id as EvidenceId, envLine: b.envLine as EnvLineId, envSnapshot: b.envSnapshot as EnvSnapshotId, runClass: 'open', fields };
  validateRecord(rec);
  return rec;
}

export function renderBlind(c: { readonly steps: readonly string[]; readonly data: string; readonly measure: readonly string[]; readonly assertions: readonly string[]; readonly evidence: EvidenceBindingT }): string {
  return (
    `## Evidence run ${c.evidence.id}${c.evidence.attempt !== null ? ` (registered attempt ${c.evidence.attempt})` : ''}\n\n` +
    `## Steps (follow them in order)\n${c.steps.map((s, i) => `${i + 1}. ${s}`).join('\n')}\n\n` +
    (c.data.trim() !== '' ? `## Data\n${c.data.trim()}\n\n` : '') +
    list('Record these quantities (each exactly once)', c.measure) +
    (c.assertions.length > 0 ? `## Assertions (answer each: holds, does not hold, not checked)\n${c.assertions.map((a, i) => `${i + 1}. ${a}`).join('\n')}\n\n` : '')
  );
}

// ---------------------------------------------------------------- the Constructor's blind-experiment card

export const ExperimentCardSchema = z.object({
  ...commonCardFields,
  seat: z.literal('constructor-experiment'),
  /** Writable paths are scratch for the experiment: their export is not a product. */
  workspace: Workspace,
  /** The interpreter and tools the steps assume (e.g. "node 22"). */
  interpreter: z.string(),
  ...blindFields,
});
export type ExperimentCard = z.infer<typeof ExperimentCardSchema>;

function experimentProblems(card: ExperimentCard, r: BlindResult, snapshot?: SnapshotFiles): string[] {
  const out = blindProblems(card, r, snapshot);
  if (card.measure.length === 0 && card.assertions.length === 0) out.push('card: an evidence run records at least one quantity or checks one assertion');
  return out;
}

export const EXPERIMENT_DEFINITION = [
  'You are the Constructor seat of a software pipeline, on a blind-experiment card. You carry out one evidence run exactly as the card\'s steps say, and record what happened. You do not know, and must not guess, what anyone expects the result to be.',
  TOOLS_NOTE_SNAPSHOT,
  'What you do: follow the steps in order, with the data given; run commands with run_command; write files only under the writable paths, if the card lists any, or from your commands into /tmp (all of it is scratch: nothing you write is a product). Record each quantity the card names, exactly once, and answer each assertion: holds, does not hold, or not checked. Every value and every answer cites the record it rests on: run:<k> for your k-th run_command (counting from 1), or file:<path>[:<line>] for a file of the snapshot. The program checks these records; a claim without one does not count as evidence. A run has a declared memory peak; nothing a command starts outlives that command.',
  'Card fields: steps (required), data, quantities to record (required, may be empty only when there are assertions), assertions, the evidence id, materials, and the interpreter.',
  'Hand-back (submit_result, once): one entry per step (done yes / no / partly, with a note), one per quantity (the value, or "not obtained: <why>", and its source), one per assertion, and your observations. Then end your turn.',
  'Prohibitions: do not change the steps, skip one silently, or "fix" what you are measuring; do not interpret the result; if a step cannot be done, say so in its note and go on with the next one if you can.',
  'Upstream: the program, on behalf of the exploration that asked for the evidence. Downstream: the program records your report as evidence; the exploration\'s author and attacker read it.',
  'Your tools: read_file, list_directory, search_content, write_file, edit_file, run_command, read_material, submit_result.',
].join('\n\n');

export function renderExperimentCard(c: ExperimentCard): string {
  return (
    renderCommon(c) +
    renderBlind(c) +
    (c.workspace.writablePaths.length > 0
      ? list('Writable paths (scratch; nothing written is kept as a product)', c.workspace.writablePaths)
      : '## Writable paths\nNone: write scratch files from your commands into /tmp.\n\n') +
    (c.interpreter !== '' ? `## Interpreter\n${c.interpreter}\n\n` : '') +
    renderMaterials(c.materials) +
    'When done, call submit_result once with your report, then end your turn.'
  );
}

export const experimentEntry: SeatCardEntry<ExperimentCard, BlindResult> = {
  kind: 'constructor-experiment',
  seat: 'constructor',
  schema: ExperimentCardSchema,
  resultShape: BlindResultShape,
  resultSchema: BlindResultSchema,
  definition: EXPERIMENT_DEFINITION,
  toolProfile: 'write',
  render: renderExperimentCard,
  problems: (c, r, ctx) => experimentProblems(c, r, ctx.snapshot),
  // the evidence record is the program's (review r1 #20): the exploration flow writes it once it
  // has checked the claims against the launch's run records (records.ts RunLayerRecord)
  records: (): BaseRecord[] => [],
};

registerSeatCard(experimentEntry);
