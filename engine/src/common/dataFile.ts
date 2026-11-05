// Data outside the commit (4.1.3, E-4): a file a seat cites by absolute path with its sha256 and
// size (`data:<path>...#sha256=<hex>&size=<bytes>`, the grammar is in seat/cards/experiment.ts).
// The program checks it at hand-back, before the write transaction and never inside it, and a
// later read (`mp read show evidence <id> --check-data`) checks it again. Both use checkDataFile.
//
// The file is hashed by streaming. A file over DATA_PARTIAL_OVER (2 GiB) is checked partially
// (D-1: mostly correct is enough): its size, and the sha256 of its first and last 64 MiB taken
// together (the "sample"); its full sha256 is then not checked, and the record says so.
// A path that is not a regular file is never opened for reading (a FIFO or a device would block
// or never end).

import { createHash } from 'node:crypto';
import { constants, promises as fsp } from 'node:fs';
import { isAbsolute } from 'node:path';

/** Above this size a data file is checked partially: its size and the sha256 of its first and last DATA_SAMPLE_BYTES. */
export const DATA_PARTIAL_OVER = 2 * 1024 * 1024 * 1024;
/** How much of each end of a large data file a partial check hashes. */
export const DATA_SAMPLE_BYTES = 64 * 1024 * 1024;

export type DataCheckKind = 'full' | 'partial';

/** One data file as the program found it. */
export interface DataFileCheck {
  readonly path: string;
  /** ok: a regular file the program read; otherwise why it could not be checked. */
  readonly state: 'ok' | 'not-absolute' | 'missing' | 'not-a-file' | 'unreadable';
  /** The reason in words, when the state is not ok. */
  readonly reason: string | null;
  readonly size: number | null;
  readonly check: DataCheckKind;
  /** A full check: the file's sha256. */
  readonly sha256: string | null;
  /** A partial check: the sha256 of its first and last DATA_SAMPLE_BYTES, taken together. */
  readonly sample: string | null;
}

export interface DataCheckOptions {
  /** Default DATA_PARTIAL_OVER. */
  readonly partialOver?: number;
  /** Default DATA_SAMPLE_BYTES. */
  readonly sampleBytes?: number;
  /** Check this way whatever the size (a later check repeats the kind recorded at hand-back). */
  readonly kind?: DataCheckKind;
}

const CHUNK = 1024 * 1024;

async function hashRange(fh: fsp.FileHandle, h: ReturnType<typeof createHash>, start: number, end: number): Promise<void> {
  const buf = Buffer.allocUnsafe(Math.min(CHUNK, Math.max(1, end - start)));
  let pos = start;
  while (pos < end) {
    const { bytesRead } = await fh.read(buf, 0, Math.min(buf.length, end - pos), pos);
    if (bytesRead === 0) break;
    h.update(buf.subarray(0, bytesRead));
    pos += bytesRead;
  }
}

/** Check one data file: whether it is a regular readable file, its size, and its sha256 (or its sample, for a large file). Never throws. */
export async function checkDataFile(path: string, o: DataCheckOptions = {}): Promise<DataFileCheck> {
  const partialOver = o.partialOver ?? DATA_PARTIAL_OVER;
  const sampleBytes = o.sampleBytes ?? DATA_SAMPLE_BYTES;
  const fail = (state: DataFileCheck['state'], reason: string, size: number | null = null): DataFileCheck => ({ path, state, reason, size, check: o.kind ?? 'full', sha256: null, sample: null });
  if (!isAbsolute(path)) return fail('not-absolute', 'the path is not absolute');
  let st;
  try {
    st = await fsp.stat(path);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return code === 'ENOENT' || code === 'ENOTDIR' ? fail('missing', 'no such file') : fail('unreadable', `it cannot be read (${code ?? (e as Error).message})`);
  }
  if (!st.isFile()) return fail('not-a-file', st.isDirectory() ? 'it is a directory, not a regular file' : 'it is not a regular file');
  let fh: fsp.FileHandle;
  try {
    // O_NONBLOCK: a path swapped for a FIFO after the stat does not block the open
    fh = await fsp.open(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
  } catch (e) {
    return fail('unreadable', `it cannot be read (${(e as NodeJS.ErrnoException).code ?? (e as Error).message})`, st.size);
  }
  try {
    const fst = await fh.stat();
    if (!fst.isFile()) return fail('not-a-file', 'it is not a regular file');
    const size = fst.size;
    const kind: DataCheckKind = o.kind ?? (size > partialOver ? 'partial' : 'full');
    const h = createHash('sha256');
    if (kind === 'full' || size <= 2 * sampleBytes) await hashRange(fh, h, 0, size);
    else {
      await hashRange(fh, h, 0, sampleBytes);
      await hashRange(fh, h, size - sampleBytes, size);
    }
    const hex = h.digest('hex');
    return { path, state: 'ok', reason: null, size, check: kind, sha256: kind === 'full' ? hex : null, sample: kind === 'partial' ? hex : null };
  } catch (e) {
    return fail('unreadable', `it cannot be read (${(e as NodeJS.ErrnoException).code ?? (e as Error).message})`, st.size);
  } finally {
    await fh.close().catch(() => undefined);
  }
}

/** Check each distinct path once (a hand-back may cite one file many times), one after the other. */
export async function checkDataFiles(paths: Iterable<string>, o: DataCheckOptions = {}): Promise<Map<string, DataFileCheck>> {
  const out = new Map<string, DataFileCheck>();
  for (const p of paths) if (!out.has(p)) out.set(p, await checkDataFile(p, o));
  return out;
}
