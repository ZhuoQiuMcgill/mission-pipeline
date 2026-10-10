// A directory in the content store (design 6.5 "内容库"; 6.2 recovery state): each file stored
// by its content, plus one tree document listing paths, kinds, modes, sizes and hashes.
// Symlinks are kept as entries (target text), never followed. Used for the Constructor's
// export, the transcript, and the session state a resumed seat continues from.
//
// The seat host streams trees straight into the store (exec/export.ts exportToStore, within the
// launch's ExportBudget); storeExportedTree is kept for a tree already exported to a host
// directory (diagnostics and tests). A tree document may say it is incomplete and why (a
// transcript cut at the export allowance, 7.1 "结束时").

import { existsSync, mkdirSync, readFileSync, rmdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, posix } from 'node:path';
import { contentHash, type ContentHash } from '../common/ids.ts';
import { EXPORT_DOC_OBJECTS, EXPORT_INDEX_RECORD_BYTES, TREE_DOC_FRAME_BYTES, TREE_INCOMPLETE_BYTES, type ExportCaps, type ExportManifest, type TreeDocument, type TreeEntry } from '../exec/export.ts';
import type { ContentStore } from '../ledger/content.ts';

export type { TreeDocument, TreeEntry, TreeIncomplete } from '../exec/export.ts';

/** Stores an exported directory (exportAreas wrote it to `dir`) and returns the tree document's hash. */
export function storeExportedTree(content: ContentStore, dir: string, manifest: ExportManifest): ContentHash {
  const entries: TreeEntry[] = manifest.entries.map((e) => ({
    path: e.path,
    kind: e.kind,
    mode: e.mode,
    size: e.size,
    hash: e.kind === 'file' ? content.put(readFileSync(join(dir, e.path))) : null,
    target: e.target,
  }));
  const doc: TreeDocument = { format: 'mp4.tree.v1', entries };
  return content.put(JSON.stringify(doc));
}

export function readTree(content: ContentStore, hash: ContentHash): TreeDocument {
  const doc = JSON.parse(content.get(hash).toString('utf8')) as TreeDocument;
  if (doc.format !== 'mp4.tree.v1' || !Array.isArray(doc.entries)) throw new Error(`${hash} is not a tree document`);
  return doc;
}

function safe(p: string): string {
  const n = posix.normalize(p);
  if (p === '' || posix.isAbsolute(p) || n !== p || n === '..' || n.startsWith('../')) throw new Error(`bad tree path ${JSON.stringify(p)}`);
  return n;
}

/**
 * Checks, before anything is written, that a stored tree fits `caps` (code review r2 finding 6):
 * it is complete (no cut entry, no incomplete marker), its paths are safe, every file object
 * exists with exactly the length the tree claims, and its entries and logical length (file
 * contents and symlink targets) are within the caps. Throws with the reason otherwise.
 */
export function checkTreeWithin(content: ContentStore, hash: ContentHash, caps: ExportCaps): { readonly logicalBytes: number; readonly entries: number } {
  // the tree document itself is bounded too (an entry is at most one index allowance on average)
  const docBytes = statSync(content.path(hash)).size;
  const docCap = (caps.maxFiles + EXPORT_DOC_OBJECTS) * EXPORT_INDEX_RECORD_BYTES + TREE_DOC_FRAME_BYTES + TREE_INCOMPLETE_BYTES;
  if (docBytes > docCap) throw new Error(`its tree document is ${docBytes} bytes, over what ${caps.maxFiles} entries allow`);
  const doc = readTree(content, hash);
  if (doc.incomplete !== undefined) throw new Error(`it is incomplete (${doc.incomplete.reason})`);
  if (doc.entries.length > caps.maxFiles) throw new Error(`it has ${doc.entries.length} entries, over the cap of ${caps.maxFiles}`);
  let logicalBytes = 0;
  for (const e of doc.entries) {
    safe(e.path);
    if (e.truncatedFrom !== undefined) throw new Error(`${e.path} was cut`);
    if (e.kind === 'file') {
      if (e.hash === null || !Number.isSafeInteger(e.size) || e.size < 0) throw new Error(`${e.path} is not a stored file`);
      const actual = statSync(content.path(contentHash(e.hash))).size;
      if (actual !== e.size) throw new Error(`${e.path} is ${actual} bytes in the store, ${e.size} in the tree`);
      logicalBytes += actual;
    } else if (e.kind === 'symlink') {
      logicalBytes += Buffer.byteLength(e.target ?? '');
    } else if (e.kind !== 'dir') throw new Error(`${e.path} has an unknown kind`);
    if (logicalBytes > caps.maxLogicalBytes) throw new Error(`it holds more than the cap of ${caps.maxLogicalBytes} bytes`);
  }
  return { logicalBytes, entries: doc.entries.length };
}

/**
 * Writes a stored tree's directories and files under `dest` (symlinks are not recreated).
 * A recovery state is whole or unusable (6.2): with `caps`, the tree is checked against them
 * before the first byte is written (checkTreeWithin); every object's content is verified as it
 * is read, the bytes written are counted against the caps, and on any failure everything this
 * call wrote is removed again.
 */
export function restoreTree(content: ContentStore, hash: ContentHash, dest: string, caps?: ExportCaps): number {
  if (caps !== undefined) checkTreeWithin(content, hash, caps);
  const doc = readTree(content, hash);
  if (doc.incomplete !== undefined) throw new Error(`${hash} is incomplete (${doc.incomplete.reason})`);
  const made: { path: string; dir: boolean }[] = [];
  let files = 0;
  let written = 0;
  try {
    for (const e of doc.entries) {
      const target = join(dest, safe(e.path));
      if (e.truncatedFrom !== undefined) throw new Error(`${e.path} was cut in ${hash}`);
      if (e.kind === 'dir') mkdirTracked(target, made);
      else if (e.kind === 'file' && e.hash !== null) {
        mkdirTracked(dirname(target), made);
        const data = content.get(contentHash(e.hash)); // verified against its hash
        written += data.length;
        if (caps !== undefined && written > caps.maxLogicalBytes) throw new Error(`more than the cap of ${caps.maxLogicalBytes} bytes`);
        writeFileSync(target, data, { mode: 0o600, flag: 'wx' });
        made.push({ path: target, dir: false });
        files++;
      }
    }
  } catch (e) {
    for (const m of made.reverse()) {
      try {
        if (m.dir) rmdirSync(m.path);
        else unlinkSync(m.path);
      } catch {
        /* the caller removes the seed directory too */
      }
    }
    throw e;
  }
  return files;
}

function mkdirTracked(dir: string, made: { path: string; dir: boolean }[]): void {
  const missing: string[] = [];
  for (let d = dir; !existsSync(d); d = dirname(d)) missing.unshift(d);
  for (const d of missing) {
    mkdirSync(d, { mode: 0o700 });
    made.push({ path: d, dir: true });
  }
}
