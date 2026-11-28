// 4.4 (F10, issue 65): files mp keeps by reference, so that evidence outside the commit survives the
// folder it was written in. A run's checkout (`tmp/<run>/`) and a seat's hand-back folder
// (`tmp/<dispatch>/`) are removed once their work is recorded; the files a declared command names as
// its artifacts, and the files a Constructor's hand-back names, are copied first into
// `.mission-pipeline/files/<sha256>`, content-addressed (one copy per content), and the record names the
// copy with its sha256 and size. The memory folder carries them when it is copied (the memory stays
// neutral). Bounded: at most KEEP_FILES files per run or hand-back, each at most KEEP_FILE_BYTES, together
// at most KEEP_TOTAL_BYTES; what is over a bound, unreadable or changed while it was copied is recorded
// with why no copy was kept. Keeping never refuses the run or the hand-back that asks for it.

import { createHash, randomBytes } from 'node:crypto';
import { constants, promises as fsp } from 'node:fs';
import { join, posix } from 'node:path';
import type { RunArtifactT } from '../seat/card.ts';
import { checkDataFile } from '../common/dataFile.ts';
import { ARTIFACTS_LINE, KEPT_ARTIFACTS, type KeptArtifactsBody } from '../flow/plandoc.ts';

export { ARTIFACTS_LINE, KEPT_ARTIFACTS, type KeptArtifactsBody };

/** 4.4 (F10): the files a run kept, read from its record by its evidence id (null: it kept none). */
export function runArtifactsOf(db: { stmt(sql: string): { get(...args: unknown[]): unknown } }, data: { text(h: string): string }, mission: string, evidence: string): readonly RunArtifactT[] | null {
  const row = db.stmt('SELECT body FROM flow_events WHERE mission = ? AND line = ? AND event = ? AND key = ?').get(mission, ARTIFACTS_LINE, KEPT_ARTIFACTS, evidence) as { body: string } | undefined;
  if (row === undefined) return null;
  try {
    return (JSON.parse(data.text(row.body)) as KeptArtifactsBody).artifacts;
  } catch {
    return null;
  }
}

/**
 * 4.4 (F10, review p9-2): a run's kept files by its evidence id alone, in whichever mission's record the run
 * was written (renewal compares a rerun's files with the original's). Null: it kept none.
 */
export function keptArtifactsOf(db: { stmt(sql: string): { get(...args: unknown[]): unknown } }, data: { text(h: string): string }, evidence: string): readonly RunArtifactT[] | null {
  const row = db.stmt('SELECT body FROM flow_events WHERE line = ? AND event = ? AND key = ? LIMIT 1').get(ARTIFACTS_LINE, KEPT_ARTIFACTS, evidence) as { body: string } | undefined;
  if (row === undefined) return null;
  try {
    return (JSON.parse(data.text(row.body)) as KeptArtifactsBody).artifacts;
  } catch {
    return null;
  }
}

/** A plain path relative to the checkout root (a named artifact), else null. */
function artifactPath(dir: string, p: string): string | null {
  return posix.isAbsolute(p) || posix.normalize(p) !== p || p === '..' || p.startsWith('../') || p.split('/').includes('.git') ? null : join(dir, ...p.split('/'));
}

/**
 * 4.4 (F10, review p9-7): the named files as they are before a command runs (commands of one run share a
 * checkout): a file's sha256, "present" when it is there but too large to hash, or absent.
 */
export async function artifactStates(dir: string, paths: readonly string[]): Promise<ReadonlyMap<string, string | null>> {
  const out = new Map<string, string | null>();
  for (const p of new Set(paths)) {
    const abs = artifactPath(dir, p);
    const st = abs === null ? null : await fsp.lstat(abs).catch(() => null);
    if (abs === null || st === null || !st.isFile()) {
      out.set(p, null);
      continue;
    }
    if (st.size > KEEP_FILE_BYTES) {
      out.set(p, 'present');
      continue;
    }
    const c = await checkDataFile(abs, { kind: 'full' });
    out.set(p, c.state === 'ok' ? c.sha256 : 'present');
  }
  return out;
}

/**
 * 4.4 (F10): keep the files a declared command names as its artifacts, from the checkout `dir` it ran in,
 * before the checkout is removed. A path that is not a plain relative path of the checkout is not read.
 * Review p9-7: `before`, the files as they were before the command ran; one that was there and is unchanged
 * is kept with its origin marked not established (an earlier command, or the commit, may have written it).
 */
export async function keepArtifacts(root: string, dir: string, paths: readonly string[], budget: KeepBudget, before?: ReadonlyMap<string, string | null>): Promise<RunArtifactT[]> {
  const out: RunArtifactT[] = [];
  for (const p of [...new Set(paths)]) {
    const abs = artifactPath(dir, p);
    if (abs === null) {
      out.push({ path: p, why: 'not a path relative to the repository root' });
      continue;
    }
    const k = await keepFile(root, abs, budget);
    const was = before?.get(p) ?? null;
    const unchanged = was !== null && (was === 'present' || ('sha256' in k && k.sha256 === was));
    const origin = unchanged ? { origin: 'not-established' as const } : {};
    out.push('kept' in k ? { path: p, sha256: k.sha256, size: k.size, kept: `.mission-pipeline/${k.kept}`, ...origin } : { path: p, ...(k.sha256 !== undefined ? { sha256: k.sha256 } : {}), ...(k.size !== undefined ? { size: k.size } : {}), why: k.why === 'no such file' ? 'the run did not write it' : k.why, ...origin });
  }
  return out;
}

/** The folder of kept files, relative to the memory folder. */
export const KEPT_FILES_DIR = 'files';
/** The most files one run's command or one hand-back keeps. */
export const KEEP_FILES = 20;
/** The largest file kept (64 MiB): a report or a log, not a data set. */
export const KEEP_FILE_BYTES = 64 * 1024 * 1024;
/** The most bytes one run or one hand-back keeps together (256 MiB). */
export const KEEP_TOTAL_BYTES = 256 * 1024 * 1024;

/** A kept copy's path relative to the memory folder. */
export function keptFilePath(sha256: string): string {
  return `${KEPT_FILES_DIR}/${sha256}`;
}

/** What keeping one file came to: the copy (relative to the memory folder) with its sha256 and size, or why there is none. */
export type KeepOutcome =
  | { readonly kept: string; readonly sha256: string; readonly size: number }
  | { readonly why: string; readonly sha256?: string; readonly size?: number };

/** A budget shared by the files of one run or one hand-back. */
export interface KeepBudget {
  files: number;
  bytes: number;
}

export function keepBudget(): KeepBudget {
  return { files: KEEP_FILES, bytes: KEEP_TOTAL_BYTES };
}

const CHUNK = 1024 * 1024;

/**
 * Copy `src` (a regular file, never followed through a link) into the kept files of the memory folder
 * `root`, hashing it as it is copied. `expect`: the sha256 the record names (a handed-in file, checked
 * before): a copy of other content is dropped. Never throws.
 */
export async function keepFile(root: string, src: string, budget: KeepBudget, expect?: { readonly sha256: string; readonly size: number }): Promise<KeepOutcome> {
  let fh: fsp.FileHandle | null = null;
  let out: fsp.FileHandle | null = null;
  const dir = join(root, KEPT_FILES_DIR);
  const tmp = join(dir, `.tmp-${randomBytes(6).toString('hex')}`);
  try {
    const st = await fsp.lstat(src).catch(() => null);
    if (st === null) return { why: 'no such file' };
    if (st.isSymbolicLink()) return { why: 'it is a link, not a regular file' };
    if (!st.isFile()) return { why: 'it is not a regular file' };
    if (budget.files <= 0) return { why: `more than ${KEEP_FILES} files: only the first ${KEEP_FILES} are kept`, size: st.size };
    if (st.size > KEEP_FILE_BYTES) return { why: `${st.size} bytes, over the ${KEEP_FILE_BYTES / (1024 * 1024)} MiB a kept file may have`, size: st.size };
    if (st.size > budget.bytes) return { why: `the files kept together would pass ${KEEP_TOTAL_BYTES / (1024 * 1024)} MiB`, size: st.size };
    fh = await fsp.open(src, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    if (!(await fh.stat()).isFile()) return { why: 'it is not a regular file' };
    await fsp.mkdir(dir, { recursive: true });
    out = await fsp.open(tmp, 'wx');
    const h = createHash('sha256');
    const buf = Buffer.allocUnsafe(CHUNK);
    let size = 0;
    for (;;) {
      const { bytesRead } = await fh.read(buf, 0, buf.length, null);
      if (bytesRead === 0) break;
      size += bytesRead;
      if (size > KEEP_FILE_BYTES) return { why: `it grew past the ${KEEP_FILE_BYTES / (1024 * 1024)} MiB a kept file may have while it was copied` };
      h.update(buf.subarray(0, bytesRead));
      await out.write(buf, 0, bytesRead);
    }
    await out.sync();
    await out.close();
    out = null;
    const sha256 = h.digest('hex');
    if (expect !== undefined && (sha256 !== expect.sha256 || size !== expect.size)) return { why: 'the file changed after it was checked: the copy is not of the file cited', sha256, size };
    const rel = keptFilePath(sha256);
    const final = join(root, ...rel.split('/'));
    const there = await fsp.stat(final).catch(() => null);
    if (there !== null && there.isFile() && there.size === size) await fsp.rm(tmp, { force: true });
    else await fsp.rename(tmp, final);
    budget.files -= 1;
    budget.bytes -= size;
    return { kept: rel, sha256, size };
  } catch (e) {
    return { why: `it could not be copied (${(e as NodeJS.ErrnoException).code ?? (e as Error).message})` };
  } finally {
    await out?.close().catch(() => undefined);
    await fh?.close().catch(() => undefined);
    await fsp.rm(tmp, { force: true }).catch(() => undefined);
  }
}
