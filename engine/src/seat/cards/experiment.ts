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
import type { DataCheckKind, DataFileCheck } from '../../common/dataFile.ts';
import { canonicalJson, sha256 } from '../../common/hash.ts';
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

// ---------------------------------------------------------------- data outside the commit (4.1.3, E-4)

/**
 * The pointer to a file outside the repository: its absolute path, an optional line or line range,
 * and the sha256 and size of what was read. A line suffix is read only when everything after the
 * last colon is digits (a range: digits-digits), so a path with colons still parses; a path that
 * itself ends in ":<digits>" takes a line suffix too (or writes that colon as %3A). The path is
 * percent-decoded after the line suffix is read: a space is written %20, a literal % as %25 (a %
 * not followed by two hex digits is kept as it is). The program checks the file at hand-back.
 */
export const DATA_POINTER_FORM = 'data:<absolute path>[:<line>[-<line>]]#sha256=<64 hex>&size=<bytes>';

/** The one line the reader, executor and author cards carry about data outside the commit. */
export const DATA_POINTER_LINE = `Data outside the repository (a file that is not in the commit): cite it as ${DATA_POINTER_FORM}, with the sha256 and size of the file you read (write a space in the path as %20, a % as %25); mp checks both when you hand back.`;

/** How a data pointer is labelled wherever it is shown, by the check the program made at hand-back. */
export const DATA_LABEL: Readonly<Record<DataCheckKind, string>> = {
  full: 'outside the commit (sha256 checked at hand-back)',
  partial: 'outside the commit (size checked at hand-back; only its first and last 64 MiB were hashed, so its sha256 was not checked)',
};

export interface DataPointer {
  /** The pointer as written. */
  readonly text: string;
  readonly path: string;
  /** "12" or "12-20", or null. */
  readonly line: string | null;
  /** Lower case. */
  readonly sha256: string;
  readonly size: number;
}

const DATA_RE = /\bdata:(\S+?)#sha256=([0-9a-fA-F]{64})&size=(\d+)/g;
/** The start of a data pointer to an absolute path (POSIX or Windows), complete or not. */
const DATA_START = /\bdata:(?:\/|[A-Za-z]:[\\/])\S*/g;

function splitLine(loc: string): { readonly path: string; readonly line: string | null } {
  const m = /^(.+):(\d+(?:-\d+)?)$/.exec(loc);
  return m === null ? { path: decodePath(loc), line: null } : { path: decodePath(m[1] as string), line: m[2] as string };
}

/** A pointer's path, percent-decoded (%20 a space, %25 a %); a % without two hex digits after it stays, and so does a path whose escapes are not UTF-8. */
function decodePath(p: string): string {
  if (!/%[0-9A-Fa-f]{2}/.test(p)) return p;
  try {
    return decodeURIComponent(p.replace(/%(?![0-9A-Fa-f]{2})/g, '%25'));
  } catch {
    return p;
  }
}

/** The complete data pointers in a text, in order. */
export function dataPointers(text: string): DataPointer[] {
  return dataMatches(text).map((x) => x.pointer);
}

function dataMatches(text: string): Array<{ readonly start: number; readonly end: number; readonly pointer: DataPointer }> {
  const out: Array<{ readonly start: number; readonly end: number; readonly pointer: DataPointer }> = [];
  for (const m of text.matchAll(DATA_RE)) {
    const size = Number(m[3]);
    if (!Number.isSafeInteger(size)) continue;
    const { path, line } = splitLine(m[1] as string);
    out.push({ start: m.index ?? 0, end: (m.index ?? 0) + m[0].length, pointer: { text: m[0], path, line, sha256: (m[2] as string).toLowerCase(), size } });
  }
  return out;
}

/** Text that starts a data pointer to an absolute path but is not a complete one (no sha256 or size): a pointer field refuses it. */
export function incompleteDataPointers(text: string): string[] {
  const full = dataMatches(text);
  return [...text.matchAll(DATA_START)].filter((m) => !full.some((f) => f.start === m.index)).map((m) => m[0]);
}

/** A text of a hand-back that may carry data pointers; `pointers`: a pointer field (a blind run's source or basis), where an incomplete one is refused. */
export interface DataText {
  readonly where: string;
  readonly text: string;
  readonly pointers?: boolean;
}

/** The checks of a hand-back's data files, by path (common/dataFile.ts checkDataFiles, before the write). */
export type DataChecks = ReadonlyMap<string, DataFileCheck>;

/** The distinct paths the data pointers of these texts name, in order. */
export function dataPaths(texts: readonly DataText[]): string[] {
  return [...new Set(texts.flatMap((t) => dataPointers(t.text).map((p) => p.path)))];
}

/** Why one data pointer does not hold, with the expected and the actual values (empty: it holds). */
export function dataPointerProblems(where: string, p: DataPointer, checks: DataChecks | undefined): string[] {
  const c = checks?.get(p.path);
  if (c === undefined) return [`${where}: ${p.text}: the file was not checked (hand back again)`];
  if (c.state !== 'ok') return [`${where}: ${p.text}: ${p.path}: ${c.reason ?? c.state} (a data pointer names a regular file mp can read, by its absolute path)`];
  const out: string[] = [];
  if (c.size !== p.size) out.push(`${where}: ${p.text}: the pointer says size=${p.size}; the file has ${String(c.size)} bytes`);
  if (c.check === 'full' && c.sha256 !== p.sha256) out.push(`${where}: ${p.text}: the pointer says sha256=${p.sha256}; the file's sha256 is ${String(c.sha256)}`);
  return out;
}

/** The problems of every data pointer in these texts; in a pointer field, an incomplete one too. */
export function dataTextProblems(texts: readonly DataText[], checks: DataChecks | undefined): string[] {
  const out: string[] = [];
  for (const t of texts) {
    for (const p of dataPointers(t.text)) out.push(...dataPointerProblems(t.where, p, checks));
    if (t.pointers === true) for (const x of incompleteDataPointers(t.text)) out.push(`${t.where}: ${x} is not a complete data pointer (${DATA_POINTER_FORM}; a space in the path is written %20)`);
  }
  return out;
}

/** A data pointer as the evidence record keeps it: what was cited and what the program checked. */
export interface RecordedData {
  readonly pointer: string;
  readonly path: string;
  readonly line: string | null;
  readonly sha256: string;
  readonly size: number;
  readonly check: DataCheckKind;
  /** A partial check: the sha256 of the first and last 64 MiB together (a later check compares it). */
  readonly sample?: string;
  readonly label: string;
}

/** The data pointers of these texts that the program checked and found to hold, each once. */
export function recordedData(texts: readonly DataText[], checks: DataChecks | undefined): RecordedData[] {
  const out: RecordedData[] = [];
  const seen = new Set<string>();
  for (const t of texts) {
    for (const p of dataPointers(t.text)) {
      if (seen.has(p.text) || dataPointerProblems('', p, checks).length > 0) continue;
      seen.add(p.text);
      const c = checks!.get(p.path)!;
      out.push({ pointer: p.text, path: p.path, line: p.line, sha256: p.sha256, size: p.size, check: c.check, ...(c.sample !== null ? { sample: c.sample } : {}), label: DATA_LABEL[c.check] });
    }
  }
  return out;
}

/** The texts of a blind hand-back that carry pointers: the sources of the recorded values and the bases of the answered assertions. */
export function blindDataTexts(r: BlindResult): DataText[] {
  return [
    ...r.measurements.filter((x) => !/^not obtained/i.test(x.value.trim())).map((x) => ({ where: `measurements[${x.measure}]`, text: x.source, pointers: true })),
    ...r.assertions.filter((a) => a.holds !== 'not-checked').map((a) => ({ where: `assertions[${a.assertion}]`, text: a.basis, pointers: true })),
  ];
}

/** One data pointer on one line, as the reads show it. */
export function recordedDataLine(d: RecordedData): string {
  return `${d.path}${d.line !== null ? `:${d.line}` : ''} — ${d.size} bytes, sha256 ${d.sha256.slice(0, 16)}…; ${d.label}`;
}

/** The data pointers an evidence record's report document keeps (none in a record from before 4.1.3). */
export function evidenceDataOf(reportDoc: string | null): RecordedData[] {
  if (reportDoc === null) return [];
  try {
    const d = (JSON.parse(reportDoc) as { data?: unknown }).data;
    return Array.isArray(d) ? (d as RecordedData[]) : [];
  } catch {
    return [];
  }
}

/** The executor's report an evidence record keeps (4.1.3, #45): its data value, its size, and whether it was cut. */
export interface ExecutorReport {
  /** The data value holding the kept text (a material of the cards that read the evidence). */
  readonly ref: string;
  /** The full report's size in UTF-8 bytes and its sha256. */
  readonly bytes: number;
  readonly sha256: string;
  /** Bytes kept, when the report was cut at EXECUTOR_REPORT_LIMIT. */
  readonly kept?: number;
  /** The leaf the hand-back filed the full report as. */
  readonly leaf?: string;
}

/** The executor's report kept with an evidence record, at most this many UTF-8 bytes (the record itself stays small: the report is a separate value). */
export const EXECUTOR_REPORT_LIMIT = 256 * 1024;

/** The executor's report the evidence record's report document names, or null (none written, or a record from before 4.1.3). */
export function executorReportOf(reportDoc: string | null): ExecutorReport | null {
  if (reportDoc === null) return null;
  try {
    const x = (JSON.parse(reportDoc) as { executorReport?: unknown }).executorReport;
    return typeof x === 'object' && x !== null && typeof (x as ExecutorReport).ref === 'string' ? (x as ExecutorReport) : null;
  } catch {
    return null;
  }
}

/**
 * The text of the executor's report to keep, cut at the limit on a character boundary with a note;
 * null when the seat wrote none. A fenced json block is left out of that test only when it holds the
 * hand-back's own fields (`o.fields`: the stdin form with no Markdown files the whole document as
 * the report); any other json block (a table the method asked for) is report.
 */
export function keptExecutorReport(report: string, leaf: string | null, o: { readonly limit?: number; readonly fields?: readonly unknown[] } = {}): { readonly text: string; readonly bytes: number; readonly sha256: string; readonly kept?: number } | null {
  const limit = o.limit ?? EXECUTOR_REPORT_LIMIT;
  const results = new Set((o.fields ?? []).filter((f) => f !== undefined).map((f) => canonicalJson(f)));
  const isResult = (block: string): boolean => {
    try {
      return results.has(canonicalJson(JSON.parse(block)));
    } catch {
      return false;
    }
  };
  if (report.replace(/^```json[ \t]*\r?\n([\s\S]*?)^```[ \t]*$/gm, (all: string, body: string) => (isResult(body) ? '' : all)).trim() === '') return null;
  const buf = Buffer.from(report, 'utf8');
  const sha = sha256(report);
  if (buf.length <= limit) return { text: report, bytes: buf.length, sha256: sha };
  let cut = limit;
  while (cut > 0 && (buf[cut]! & 0xc0) === 0x80) cut--;
  const text = `${buf.subarray(0, cut).toString('utf8')}\n\n[mp: the report was cut here: ${cut} of ${buf.length} bytes kept. The full report has sha256 ${sha}${leaf !== null ? `; it is the hand-back's report leaf ${leaf}` : ''}.]\n`;
  return { text, bytes: buf.length, sha256: sha, kept: cut };
}

export const BlindResultShape = {
  steps: z
    .array(z.object({ step: z.number().int().positive().describe('1-based step number.'), done: z.enum(['yes', 'no', 'partly']), note: z.string() }))
    .describe('Exactly one entry per step on the card.'),
  measurements: z
    .array(
      z.object({
        measure: z.string().describe('A quantity named on the card, verbatim.'),
        value: z.string().describe('The recorded value, or "not obtained: <why>".'),
        source: z.string().describe(`Where it came from, as pointers: run:<run id> (a run you had mp rerun), url:<address> with the quoted passage (a reading), file:<path>[:<line>] (a file of the commit the card names), ${DATA_POINTER_FORM} (a file outside the repository).`),
      }),
    )
    .describe('Exactly one entry per quantity on the card.'),
  assertions: z
    .array(
      z.object({
        assertion: z.number().int().positive().describe('1-based assertion number.'),
        holds: z.enum(['yes', 'no', 'not-checked']),
        basis: z.string().min(1).describe(`For yes or no: the pointers it rests on (run:<run id>, url:<address>, file:<path>[:<line>], ${DATA_POINTER_FORM}) and why.`),
      }),
    )
    .describe('Exactly one entry per assertion on the card.'),
  observations: z.string().describe('Anything else you observed while following the steps (no interpretation of what it means).'),
};
const BlindResultSchema = z.object(BlindResultShape);
export type BlindResult = z.infer<typeof BlindResultSchema>;

type BlindCard = { readonly steps: readonly string[]; readonly data: string; readonly measure: readonly string[]; readonly assertions: readonly string[]; readonly evidence: EvidenceBindingT; readonly task: string; readonly seat: string; readonly network?: { readonly allowed: readonly string[] } };

export function blindProblems(card: BlindCard, r: BlindResult, snapshot?: SnapshotFiles, data?: DataChecks): string[] {
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
  const allowed = card.seat === 'researcher-reader' ? ['url', 'file', 'data'] : ['run', 'file', 'data'];
  const show: Readonly<Record<string, string>> = { run: 'run:<run id>', url: 'url:<address>', file: 'file:<path>[:<line>]', data: DATA_POINTER_FORM };
  const addresses = card.network?.allowed ?? [];
  const check = (where: string, text: string): void => {
    const ps = blindPointers(text);
    if (ps.length === 0) out.push(`${where}: cite the record it rests on (${allowed.map((a) => show[a]).join(', ')})`);
    for (const p of ps) {
      if (!allowed.includes(p.kind)) out.push(`${where}: ${p.text} is not a record this seat can make`);
      else if (p.kind === 'file' && snapshot !== undefined && snapshot.lines(p.path) === null) out.push(`${where}: ${p.text}: ${p.path} is not a file of the commit the card names (data outside the commit: ${DATA_POINTER_FORM})`);
      else if (p.kind === 'url' && !addresses.some((a) => p.path.startsWith(a))) out.push(`${where}: ${p.text} is not an address the card allows`);
    }
  };
  for (const x of r.measurements) if (!/^not obtained/i.test(x.value.trim())) check(`measurements[${x.measure}]`, x.source);
  for (const a of r.assertions) if (a.holds !== 'not-checked') check(`assertions[${a.assertion}]`, a.basis);
  // 4.1.3 (E-4): data outside the commit, checked against the file before the write (a mismatch is fixed in the same dispatch)
  out.push(...dataTextProblems(blindDataTexts(r), data));
  return out;
}

export interface BlindPointer {
  readonly kind: 'run' | 'url' | 'file' | 'data';
  readonly text: string;
  /** run: the run id; url: the address; file and data: the path. */
  readonly path: string;
  /** data: the whole pointer. */
  readonly data?: DataPointer;
}

/**
 * The record pointers in a source or basis text: run:<run id>, url:<address>,
 * file:<path>[:<a>[-<b>]], and (4.1.3) data:<absolute path>[:<a>[-<b>]]#sha256=<hex>&size=<n>.
 * A text with no complete data pointer parses exactly as before 4.1.3; inside a data pointer no
 * other pointer is read (its path may hold "run:" or "file:").
 */
export function blindPointers(text: string): BlindPointer[] {
  const data = dataMatches(text);
  const out: Array<BlindPointer & { readonly at: number }> = data.map((d) => ({ kind: 'data' as const, text: d.pointer.text, path: d.pointer.path, data: d.pointer, at: d.start }));
  for (const m of text.matchAll(/\brun:([A-Za-z0-9][A-Za-z0-9._:-]*[A-Za-z0-9])|\burl:(\S+)|\bfile:([^\s:,;]+)(?::\d+(?:-\d+)?)?/g)) {
    const at = m.index ?? 0;
    if (data.some((d) => at >= d.start && at < d.end)) continue;
    if (m[1] !== undefined) out.push({ kind: 'run', text: m[0], path: m[1], at });
    else if (m[2] !== undefined) out.push({ kind: 'url', text: m[0], path: m[2].replace(/[),.;]+$/, ''), at });
    else out.push({ kind: 'file', text: m[0], path: m[3] as string, at });
  }
  return out.sort((a, b) => a.at - b.at).map(({ at: _at, ...p }) => p);
}

/**
 * Whether every claim of a blind hand-back rests on a record (review r1 #20): run:<id> must be
 * a run of this dispatch (`mp seat <id> rerun`) that completed; url and file pointers were
 * checked at hand-back (an allowed address; a file of the commit); a data pointer rests on a
 * record only when the program checked its file and it held (`data`: the hand-back's checks).
 * Returns the claims that do not.
 */
export function unbackedClaims(r: BlindResult, records: { readonly runs: ReadonlyArray<{ readonly run: string; readonly completed: boolean }> | null; readonly data?: DataChecks }): string[] {
  const out: string[] = [];
  const ok = (p: BlindPointer): boolean =>
    p.kind === 'file' || p.kind === 'url' || (p.kind === 'run' && records.runs !== null && records.runs.some((x) => x.run === p.path && x.completed)) || (p.kind === 'data' && p.data !== undefined && dataPointerProblems('', p.data, records.data).length === 0);
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

/**
 * The program's record of a blind run (4.1 §6.5: an exploration's experiment is a sampling run, never reused or renewed).
 * 4.1.3: `ctx.data` (the hand-back's data checks) records each data pointer with what was checked,
 * in the report document (`data`) and in the fields (`data:<n>`); `ctx.report` (the executor's
 * report) is kept as a value of its own, cut at EXECUTOR_REPORT_LIMIT, which the record names
 * (`executorReport`). Without them the record is the one 4.1.2 made.
 */
export function blindEvidenceRecord(
  card: BlindCard,
  r: BlindResult,
  executor: 'experiment' | 'reading',
  ctx: Pick<CardRecordContext, 'content' | 'data' | 'report'>,
  runs: ReadonlyArray<{ readonly run: string; readonly completed: boolean; readonly envLine?: string; readonly envSnapshot?: string }> | null = null,
): EvidenceRecord {
  const unbacked = unbackedClaims(r, { runs, ...(ctx.data !== undefined ? { data: ctx.data } : {}) });
  const urls = [...new Set([...r.measurements.map((x) => x.source), ...r.assertions.map((a) => a.basis)].flatMap((t) => blindPointers(t).filter((p) => p.kind === 'url').map((p) => p.path)))];
  const data = recordedData(blindDataTexts(r), ctx.data);
  const kept = ctx.report === undefined || ctx.report === null ? null : keptExecutorReport(ctx.report.text, ctx.report.leaf, { fields: [ctx.report.fields, r] });
  const leaf = ctx.report?.leaf ?? null;
  const executorReport: ExecutorReport | null = kept === null ? null : { ref: ctx.content.put(kept.text), bytes: kept.bytes, sha256: kept.sha256, ...(kept.kept !== undefined ? { kept: kept.kept } : {}), ...(leaf !== null ? { leaf } : {}) };
  const doc = {
    ...(JSON.parse(blindReportDocument(card, r)) as object),
    ...(urls.length > 0 ? { cited: urls } : {}),
    ...(runs !== null ? { runs } : {}),
    unbacked,
    ...(data.length > 0 ? { data } : {}),
    ...(executorReport !== null ? { executorReport } : {}),
  };
  // "completed" only when every claim rests on a record; else "unverified" (no rebuttal can rest on it)
  const fields: Record<string, string> = { status: unbacked.length === 0 ? 'completed' : 'unverified', executor, report: ctx.content.put(JSON.stringify(doc)) };
  if (unbacked.length > 0) fields['unbacked'] = String(unbacked.length);
  if (urls.length > 0) fields['urls'] = String(urls.length);
  urls.slice(0, 20).forEach((u, i) => (fields[`url:${i + 1}`] = short(u)));
  (runs ?? []).slice(0, 20).forEach((x, i) => (fields[`run:${i + 1}`] = `${x.run} ${x.completed ? 'completed' : 'failed'}`));
  // the path in full (a later check reads it); the report document holds every one
  if (data.length > 0) fields['data'] = String(data.length);
  // the path and line as the pointer writes them (percent-encoded: no space), so the field splits on spaces
  data.slice(0, 20).forEach((d, i) => (fields[`data:${i + 1}`] = `${d.pointer.slice('data:'.length, d.pointer.indexOf('#sha256='))} sha256=${d.sha256} size=${d.size} check=${d.check}${d.sample !== undefined ? ` sample=${d.sample}` : ''}`));
  if (executorReport !== null) {
    fields['executorReport'] = executorReport.ref;
    if (executorReport.kept !== undefined) fields['executorReportCut'] = `${executorReport.kept} of ${executorReport.bytes} bytes kept; the full report has sha256 ${executorReport.sha256}`;
  }
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
 * The evidence summary's note on its data outside the commit (4.1.3): appended to the summary the
 * cards, the hand-off and the reads show, so the label travels with the evidence. Empty without any.
 */
export function evidenceDataNote(rec: Pick<EvidenceRecord, 'fields'>): string {
  const n = Number(rec.fields['data'] ?? '0');
  if (!(n > 0)) return '';
  const files = Array.from({ length: Math.min(n, 20) }, (_, i) => rec.fields[`data:${i + 1}`] ?? '').filter((x) => x !== '').map((x) => {
    const [where, , , check] = x.split(' ');
    return `${where} (${DATA_LABEL[check === 'check=partial' ? 'partial' : 'full'].replace(/^outside the commit \(|\)$/g, '')})`;
  });
  const shown = files.slice(0, 3).join(', ');
  return ` | data ${n === 1 ? 'file' : 'files'} outside the commit: ${shown}${n > 3 ? `, and ${n - 3} more` : ''}`;
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
    (c.assertions.length > 0 ? `## Assertions (answer each: holds, does not hold, not checked)\n${c.assertions.map((a, i) => `${i + 1}. ${a}`).join('\n')}\n\n` : '') +
    `${DATA_POINTER_LINE}\n\n`
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

function experimentProblems(card: ExperimentCard, r: BlindResult, snapshot?: SnapshotFiles, data?: DataChecks): string[] {
  const out = blindProblems(card, r, snapshot, data);
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
  problems: (c, r, ctx) => experimentProblems(c, r, ctx.snapshot, ctx.data),
  dataTexts: blindDataTexts,
  // the evidence record is the program's (review r1 #20), its claims checked against the
  // dispatch's runs; 4.1.3: made at the hand-back, where the data checks and the executor's
  // report are at hand (the reading's is made there too). The flow makes it from the runs only
  // for a hand-back recorded before 4.1.3 (exploration/flow.ts blindRecordOf).
  records: (c, r, ctx) => [blindEvidenceRecord(c, r, 'experiment', ctx, ctx.runs ?? [])],
};

registerSeatCard(experimentEntry);
