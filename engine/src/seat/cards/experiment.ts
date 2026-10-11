// Blind evidence executions (design 4.1 §6.3; 4.0 4.3 "证据执行", 6.2 async evidence, 8.2): the
// Constructor's blind-experiment card, and the pieces it shares with the Researcher's blind
// reading card (src/seat/cards/researcher.ts). The executor's card holds only the steps, the
// data, what to record, the assertions and (an experiment) the commands the steps run, never the
// author's or the attacker's expectation (4.3). An experiment runs each command with
// `mp seat <id> rerun <command-id>`: every rerun is a sampling run (§6.5) with its own run id,
// cited as run:<run id>. A reading fetches pages with the harness's own tools and cites them as
// url:<address> with the quoted passage (decision 12: `mp` does not verify them; it checks only
// that the address is one the card allows). The executor hands back, step by step, what it did,
// the recorded quantities and whether each assertion held; the program records that as one
// evidence record (5.1 "探索的执行记录") whose full report is a data value. A run that failed or
// never ran gets its record from the program instead (8.2: no measurement is required of a
// failed attempt).

import { z } from 'zod';
import type { EnvLineId, EnvSnapshotId, EvidenceId } from '../../common/ids.ts';
import type { BaseRecord, EvidenceRecord } from '../../common/records.ts';
import { validateRecord } from '../../common/validate.ts';
import { Command, Material, Workspace, commonCardFields, list, renderCommon, renderMaterials } from './common.ts';
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
        source: z.string().describe('Where it came from, as pointers: run:<run id> (a run you had mp rerun), url:<address> with the quoted passage (a reading), file:<path>[:<line>] (a file of the commit the card names).'),
      }),
    )
    .describe('Exactly one entry per quantity on the card.'),
  assertions: z
    .array(
      z.object({
        assertion: z.number().int().positive().describe('1-based assertion number.'),
        holds: z.enum(['yes', 'no', 'not-checked']),
        basis: z.string().min(1).describe('For yes or no: the pointers it rests on (run:<run id>, url:<address>, file:<path>[:<line>]) and why.'),
      }),
    )
    .describe('Exactly one entry per assertion on the card.'),
  observations: z.string().describe('Anything else you observed while following the steps (no interpretation of what it means).'),
};
const BlindResultSchema = z.object(BlindResultShape);
export type BlindResult = z.infer<typeof BlindResultSchema>;

type BlindCard = { readonly steps: readonly string[]; readonly data: string; readonly measure: readonly string[]; readonly assertions: readonly string[]; readonly evidence: EvidenceBindingT; readonly task: string; readonly seat: string; readonly network?: { readonly allowed: readonly string[] } };

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
  const allowed = card.seat === 'researcher-reader' ? ['url', 'file'] : ['run', 'file'];
  const show: Readonly<Record<string, string>> = { run: 'run:<run id>', url: 'url:<address>', file: 'file:<path>[:<line>]' };
  const addresses = card.network?.allowed ?? [];
  const check = (where: string, text: string): void => {
    const ps = blindPointers(text);
    if (ps.length === 0) out.push(`${where}: cite the record it rests on (${allowed.map((a) => show[a]).join(', ')})`);
    for (const p of ps) {
      if (!allowed.includes(p.kind)) out.push(`${where}: ${p.text} is not a record this seat can make`);
      else if (p.kind === 'file' && snapshot !== undefined && snapshot.lines(p.path) === null) out.push(`${where}: ${p.text}: ${p.path} is not a file of the commit the card names`);
      else if (p.kind === 'url' && !addresses.some((a) => p.path.startsWith(a))) out.push(`${where}: ${p.text} is not an address the card allows`);
    }
  };
  for (const x of r.measurements) if (!/^not obtained/i.test(x.value.trim())) check(`measurements[${x.measure}]`, x.source);
  for (const a of r.assertions) if (a.holds !== 'not-checked') check(`assertions[${a.assertion}]`, a.basis);
  return out;
}

export interface BlindPointer {
  readonly kind: 'run' | 'url' | 'file';
  readonly text: string;
  /** run: the run id; url: the address; file: the path. */
  readonly path: string;
}

/** The record pointers in a source or basis text: run:<run id>, url:<address>, file:<path>[:<a>[-<b>]]. */
export function blindPointers(text: string): BlindPointer[] {
  const out: BlindPointer[] = [];
  for (const m of text.matchAll(/\brun:([A-Za-z0-9][A-Za-z0-9._:-]*[A-Za-z0-9])|\burl:(\S+)|\bfile:([^\s:,;]+)(?::\d+(?:-\d+)?)?/g)) {
    if (m[1] !== undefined) out.push({ kind: 'run', text: m[0], path: m[1] });
    else if (m[2] !== undefined) out.push({ kind: 'url', text: m[0], path: m[2].replace(/[),.;]+$/, '') });
    else out.push({ kind: 'file', text: m[0], path: m[3] as string });
  }
  return out;
}

/**
 * Whether every claim of a blind hand-back rests on a record (review r1 #20): run:<id> must be
 * a run of this dispatch (`mp seat <id> rerun`) that completed; url and file pointers were
 * checked at hand-back (an allowed address; a file of the commit). Returns the claims that do not.
 */
export function unbackedClaims(r: BlindResult, records: { readonly runs: ReadonlyArray<{ readonly run: string; readonly completed: boolean }> | null }): string[] {
  const out: string[] = [];
  const ok = (p: BlindPointer): boolean => p.kind === 'file' || p.kind === 'url' || (p.kind === 'run' && records.runs !== null && records.runs.some((x) => x.run === p.path && x.completed));
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
    task: card.task,
    executor: card.seat,
    evidence: card.evidence.id,
    attempt: card.evidence.attempt,
    asked: { steps: card.steps, data: card.data, measure: card.measure, assertions: card.assertions },
    result: r,
  });
}

/** The program's record of a blind run (4.1 §6.5: an exploration's experiment is a sampling run, never reused or renewed). */
export function blindEvidenceRecord(
  card: BlindCard,
  r: BlindResult,
  executor: 'experiment' | 'reading',
  ctx: Pick<CardRecordContext, 'content'>,
  runs: ReadonlyArray<{ readonly run: string; readonly completed: boolean; readonly envLine?: string; readonly envSnapshot?: string }> | null = null,
): EvidenceRecord {
  const unbacked = unbackedClaims(r, { runs });
  const urls = [...new Set([...r.measurements.map((x) => x.source), ...r.assertions.map((a) => a.basis)].flatMap((t) => blindPointers(t).filter((p) => p.kind === 'url').map((p) => p.path)))];
  const doc = { ...(JSON.parse(blindReportDocument(card, r)) as object), ...(urls.length > 0 ? { cited: urls } : {}), ...(runs !== null ? { runs } : {}), unbacked };
  // "completed" only when every claim rests on a record; else "unverified" (no rebuttal can rest on it)
  const fields: Record<string, string> = { status: unbacked.length === 0 ? 'completed' : 'unverified', executor, report: ctx.content.put(JSON.stringify(doc)) };
  if (unbacked.length > 0) fields['unbacked'] = String(unbacked.length);
  if (urls.length > 0) fields['urls'] = String(urls.length);
  urls.slice(0, 20).forEach((u, i) => (fields[`url:${i + 1}`] = short(u)));
  (runs ?? []).slice(0, 20).forEach((x, i) => (fields[`run:${i + 1}`] = `${x.run} ${x.completed ? 'completed' : 'failed'}`));
  if (card.evidence.attempt !== null) fields['attempt'] = card.evidence.attempt;
  for (const s of r.steps) fields[`step:${s.step}`] = s.done;
  for (const m of r.measurements) fields[`measure:${m.measure}`] = short(m.value);
  for (const a of r.assertions) fields[`assertion:${a.assertion}`] = a.holds;
  const env = runsEnvironment(r, runs) ?? { envLine: card.evidence.envLine, envSnapshot: card.evidence.envSnapshot };
  const rec: EvidenceRecord = {
    kind: 'evidence',
    evidence: card.evidence.id as EvidenceId,
    envLine: env.envLine as EnvLineId,
    envSnapshot: env.envSnapshot as EnvSnapshotId,
    runClass: 'sampling',
    fields,
  };
  validateRecord(rec);
  return rec;
}

/**
 * The environment identity an experiment's evidence is bound to (code review r1 #3; 4.1 §6.5,
 * decision 11): that of the runs it cites (`run:<id>`), or of every run of the dispatch when it
 * cites none; when they differ, the earliest one's, so a change in between leaves the evidence
 * needing a rerun. Null (a reading, no runs): the exploration's own line, environment-free.
 */
export function runsEnvironment(
  r: BlindResult,
  runs: ReadonlyArray<{ readonly run: string; readonly envLine?: string; readonly envSnapshot?: string }> | null,
): { readonly envLine: string; readonly envSnapshot: string } | null {
  if (runs === null || runs.length === 0) return null;
  const cited = new Set([...r.measurements.map((x) => x.source), ...r.assertions.map((a) => a.basis)].flatMap((t) => blindPointers(t).filter((p) => p.kind === 'run').map((p) => p.path)));
  const bound = runs.filter((x) => x.envLine !== undefined && x.envSnapshot !== undefined);
  const chosen = bound.filter((x) => cited.has(x.run));
  const from = chosen.length > 0 ? chosen : bound;
  const first = from[0];
  return first === undefined ? null : { envLine: first.envLine!, envSnapshot: first.envSnapshot! };
}

/**
 * The record the program writes for an attempt that failed, was interrupted or never ran (8.2:
 * generated by the program; no measurement is asked of it).
 */
export function failedEvidenceRecord(b: EvidenceBindingT, status: 'failed' | 'not-run', reason: string, executor: 'experiment' | 'reading'): EvidenceRecord {
  const fields: Record<string, string> = { status, executor, reason: short(reason) };
  if (b.attempt !== null) fields['attempt'] = b.attempt;
  const rec: EvidenceRecord = { kind: 'evidence', evidence: b.id as EvidenceId, envLine: b.envLine as EnvLineId, envSnapshot: b.envSnapshot as EnvSnapshotId, runClass: 'sampling', fields };
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
  /** The commands the steps run (decision 11): the seat runs each with `mp seat <id> rerun <command-id>`. */
  commands: z.array(Command),
  ...blindFields,
});
export type ExperimentCard = z.infer<typeof ExperimentCardSchema>;

function experimentProblems(card: ExperimentCard, r: BlindResult, snapshot?: SnapshotFiles): string[] {
  const out = blindProblems(card, r, snapshot);
  if (card.measure.length === 0 && card.assertions.length === 0) out.push('card: an evidence run records at least one quantity or checks one assertion');
  return out;
}


export function renderExperimentCard(c: ExperimentCard): string {
  return (
    renderCommon(c) +
    renderBlind(c) +
    list('The commands of the steps (run each with the rerun command below; cite each run as run:<run id>)', c.commands.map((x) => `[${x.id}] ${x.command}${x.cwd !== undefined ? ` (in ${x.cwd})` : ''}`)) +
    list('Scratch paths (the commands may write there in their checkout; nothing written is kept)', c.workspace.writablePaths) +
    (c.interpreter !== '' ? `## Interpreter\n${c.interpreter}\n\n` : '') +
    renderMaterials(c.materials)
  );
}

export const experimentEntry: SeatCardEntry<ExperimentCard, BlindResult> = {
  kind: 'constructor-experiment',
  seat: 'constructor',
  schema: ExperimentCardSchema,
  resultShape: BlindResultShape,
  resultSchema: BlindResultSchema,
  toolProfile: 'write',
  render: renderExperimentCard,
  problems: (c, r, ctx) => experimentProblems(c, r, ctx.snapshot),
  // the evidence record is the program's (review r1 #20): the exploration flow writes it once it
  // has checked the claims against the dispatch's runs
  records: (): BaseRecord[] => [],
};

registerSeatCard(experimentEntry);
