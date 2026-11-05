// `mp read show evidence <id> [--check-data]` (4.1.3, E-4): one evidence record with what it
// rests on: its status, environment, the executor's report kept with it, and the data outside the
// commit it cites, each with the check the program made at hand-back. `--check-data` hashes each
// such file again and says, per file, unchanged, changed or missing. Read-only: it writes nothing.
// Any seat's hand-back keeps the data it cites the same way (its hand-back document): `mp read show
// dispatch <id> [--check-data]` shows it. The exploration's read (`mp read show exploration <id>`)
// shows the same data lines per evidence and per hand-back of its other seats.

import { checkDataFile, type DataFileCheck } from '../common/dataFile.ts';
import type { EvidenceRecord } from '../common/records.ts';
import type { XState } from '../flow/exploration/machine.ts';
import { dispatchInfo, listDispatches, factById } from '../memory/index.ts';
import { handbackDoc } from '../process/index.ts';
import { evidenceDataOf, executorReportOf, recordedDataLine, type RecordedData } from '../seat/cards/experiment.ts';
import type { Project } from './project.ts';

/** One data file checked again now. */
export interface DataRecheck {
  readonly path: string;
  readonly pointer: string;
  readonly state: 'unchanged' | 'changed' | 'missing';
  readonly detail: string;
}

/** Hash a recorded data file again, the way it was checked at hand-back, and compare. */
export async function recheckData(d: RecordedData, cache: Map<string, Promise<DataFileCheck>> = new Map()): Promise<DataRecheck> {
  const key = `${d.check}:${d.path}`;
  let p = cache.get(key);
  if (p === undefined) cache.set(key, (p = checkDataFile(d.path, { kind: d.check })));
  const c = await p;
  const base = { path: d.path, pointer: d.pointer };
  if (c.state !== 'ok') return { ...base, state: 'missing', detail: c.reason ?? c.state };
  if (c.size !== d.size) return { ...base, state: 'changed', detail: `the size is now ${String(c.size)} bytes (recorded ${d.size})` };
  if (d.check === 'full') return c.sha256 === d.sha256 ? { ...base, state: 'unchanged', detail: 'size and sha256 as recorded' } : { ...base, state: 'changed', detail: `the sha256 is now ${String(c.sha256)} (recorded ${d.sha256})` };
  if (d.sample === undefined) return { ...base, state: 'unchanged', detail: 'the size as recorded (no sample was recorded)' };
  return c.sample === d.sample ? { ...base, state: 'unchanged', detail: 'the size and the first and last 64 MiB as recorded (a partial check)' } : { ...base, state: 'changed', detail: 'the first or last 64 MiB changed' };
}

function textOf(p: Project, ref: string | undefined): string | null {
  if (ref === undefined) return null;
  try {
    return p.ctx.memory.data.text(ref);
  } catch {
    return null;
  }
}

/** `mp read show evidence <id>`; null when no evidence record has the id. */
export async function showEvidence(p: Project, id: string, o: { readonly checkData?: boolean } = {}): Promise<{ readonly text: string; readonly json: unknown } | null> {
  const rec = p.ctx.memory.read((db) => factById(db, 'evidence', id))?.record as EvidenceRecord | undefined;
  if (rec === undefined) return null;
  const f = rec.fields;
  const doc = textOf(p, f['report']);
  const data = evidenceDataOf(doc);
  const report = executorReportOf(doc);
  const out = [`evidence ${rec.evidence} — ${rec.runClass} run${f['executor'] !== undefined ? ` (${f['executor']})` : ''}: ${f['status'] ?? '?'}${f['reason'] !== undefined ? ` (${f['reason']})` : ''}`];
  if (f['attempt'] !== undefined) out.push(`  attempt: ${f['attempt']}`);
  out.push(`  environment: ${rec.envLine} / ${rec.envSnapshot}`);
  if (f['unbacked'] !== undefined) out.push(`  unverified: ${f['unbacked']} claim(s) rest on no program record`);
  if (f['report'] !== undefined) out.push(`  the program's record of the run: data value ${f['report']}${doc === null ? ' (cannot be read)' : ''}`);
  if (report !== null) {
    out.push(`  the executor's report: ${report.bytes} bytes, sha256 ${report.sha256}${report.leaf !== undefined ? `, leaf ${report.leaf}` : ''}`);
    out.push(`    kept with the record as data value ${report.ref}${report.kept !== undefined ? `, cut at ${report.kept} of ${report.bytes} bytes` : ''}; the author, the attacker and the interpreter read it as a material`);
  }
  if (data.length > 0) out.push(`  data outside the commit (${data.length}):`, ...data.map((d) => `    ${recordedDataLine(d)}`));
  let checked: DataRecheck[] | null = null;
  if (o.checkData === true) {
    const cache = new Map<string, Promise<DataFileCheck>>();
    checked = [];
    for (const d of data) checked.push(await recheckData(d, cache));
    out.push(data.length === 0 ? '  --check-data: this evidence cites no data outside the commit' : '  checked again now (read-only, nothing recorded):', ...checked.map((c) => `    ${c.path}: ${c.state} (${c.detail})`));
  }
  return { text: out.join('\n'), json: { evidence: rec.evidence, record: rec, executorReport: report, data, ...(checked !== null ? { checked } : {}) } };
}

/** The data outside the commit a dispatch's hand-back cites, as checked at hand-back (none before 4.1.3, or none cited). */
export function dispatchDataOf(p: Project, dispatch: string): RecordedData[] {
  const info = p.ctx.memory.read((db) => dispatchInfo(db, dispatch));
  return info === null ? [] : [...(handbackDoc(p.ctx.memory.data, info)?.data ?? [])];
}

/** `mp read show dispatch <id>`'s lines on the data its hand-back cites; `checkData`: each file hashed again, read-only. */
export async function dispatchDataLines(p: Project, dispatch: string, o: { readonly checkData?: boolean } = {}): Promise<{ readonly lines: string[]; readonly data: RecordedData[]; readonly checked: DataRecheck[] | null }> {
  const data = dispatchDataOf(p, dispatch);
  const lines = data.length > 0 ? [`  data outside the commit (${data.length}):`, ...data.map((d) => `    ${recordedDataLine(d)}`)] : [];
  if (o.checkData !== true) return { lines, data, checked: null };
  const cache = new Map<string, Promise<DataFileCheck>>();
  const checked: DataRecheck[] = [];
  for (const d of data) checked.push(await recheckData(d, cache));
  lines.push(data.length === 0 ? '  --check-data: this hand-back cites no data outside the commit' : '  checked again now (read-only, nothing recorded):', ...checked.map((c) => `    ${c.path}: ${c.state} (${c.detail})`));
  return { lines, data, checked };
}

/** The exploration read's lines on the data its evidence and its seats' hand-backs cite (none when none is cited). */
export function explorationDataLines(p: Project, s: XState): { readonly lines: string[]; readonly json: Record<string, RecordedData[]> } {
  const lines: string[] = [];
  const json: Record<string, RecordedData[]> = {};
  for (const e of [...s.evidence.values()].sort((a, b) => a.k - b.k)) {
    const data = evidenceDataOf(e.report === null ? null : textOf(p, e.report));
    if (data.length === 0) continue;
    json[e.id] = data;
    lines.push(`  evidence ${e.id}: data outside the commit (${data.length}; mp read show evidence ${e.id} --check-data checks it again)`, ...data.map((d) => `    ${recordedDataLine(d)}`));
  }
  // the author's, the interpreter's and the attacker's hand-backs (a blind run's are its evidence, above)
  for (const [task, q] of s.tasks) {
    if (q.role === 'executor') continue;
    for (const d of p.ctx.memory.read((db) => listDispatches(db, { task, limit: 100 }))) {
      const data = dispatchDataOf(p, d.dispatch);
      if (data.length === 0) continue;
      json[d.dispatch] = data;
      lines.push(`  ${q.role} hand-back ${d.dispatch} (task ${task}): data outside the commit (${data.length}; mp read show dispatch ${d.dispatch} --check-data checks it again)`, ...data.map((x) => `    ${recordedDataLine(x)}`));
    }
  }
  return { lines, json };
}
