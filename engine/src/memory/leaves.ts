// The leaves (design 4.1 §3.1, §3.2 "Writing a leaf"): Markdown files people
// and agents read, each one the skeleton names by file, anchor and the hash of
// its text.
//
// - A document (a plan version, a card, a report, a run summary...) is written
//   once: to a temporary name, then renamed into place. A change is a new
//   version, a new file.
// - A journal (words/<date>.md, constraints.md, missions/<m>/requirements.md,
//   decisions.md, notices.md) is appended to, never rewritten: each entry is a
//   block between two HTML comments that carry its anchor, derived from the
//   write's operation id, so a retry never appends it twice.
//
// A leaf is written inside the write transaction that records it, before the
// commit. Before touching a file, the write leaves a note in
// tmp/.leaves-pending/; the commit removes it. A write that rolls back removes
// its leaves itself (before releasing the lock); a process that dies mid-write
// leaves its note, and the next write (holding the lock, so no writer is in
// progress) removes every leaf of the note that has no committed reference.
// Until then such an orphan is never served: reads go through the skeleton's
// references only. So a retry after a crash neither loses nor doubles a leaf.
//
// Reading a leaf checks its hash: a missing file or entry, or text edited by
// hand, is reported, never served silently (§3.3: shown, and only the steps
// that need that content are held).

import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { sha256 } from '../common/hash.ts';
import type { ContentHash, Revision } from '../common/ids.ts';
import type { Db } from './db.ts';
import { LedgerError } from './errors.ts';
import { appendDurable, removeFile, writeAtomic } from './fsx.ts';
import { checkLeafPath, osPath } from './paths.ts';

export type LeafKind = 'document' | 'journal';

export interface LeafRef {
  /** The leaf's id: its file for a document, `<file>#<anchor>` for a journal entry. */
  readonly leaf: string;
  readonly kind: LeafKind;
  /** Relative to the memory folder, with "/". */
  readonly file: string;
  readonly anchor: string | null;
  /** sha256 of the leaf's text. */
  readonly sha256: ContentHash;
}

export type LeafStatus = 'ok' | 'missing' | 'edited';

export interface LeafRead extends LeafRef {
  readonly status: LeafStatus;
  /** The text as it is now (null when missing). */
  readonly text: string | null;
  readonly op: string | null;
  readonly revision: Revision;
}

const BEGIN = (anchor: string): string => `<!-- mp:entry ${anchor} -->\n`;
const END = (anchor: string): string => `<!-- mp:end ${anchor} -->\n`;
const MARKER = /<!-- mp:(entry|end) /;

/** What a write in progress wrote, so it can be removed if the write never commits. */
interface PendingEntry {
  readonly leaf: string;
  readonly kind: LeafKind;
  readonly file: string;
  readonly anchor: string | null;
  /** Journal entries: the blank-line separator written before the block. */
  readonly prefix: number;
}

type LeafRow = { leaf: string; kind: LeafKind; file: string; anchor: string | null; sha256: string; op: string | null; rev: number };

function leafRow(db: Db, leaf: string): LeafRow | null {
  return (db.stmt('SELECT leaf, kind, file, anchor, sha256, op, rev FROM leaves WHERE leaf = ?').get(leaf) as unknown as LeafRow | undefined) ?? null;
}

function refOf(r: LeafRow): LeafRef {
  return { leaf: r.leaf, kind: r.kind, file: r.file, anchor: r.anchor, sha256: r.sha256 as ContentHash };
}

function readText(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT' || (e as NodeJS.ErrnoException).code === 'ENOTDIR') return null;
    throw e;
  }
}

/** The text of a journal entry in a file's content, or null when its block is not there (whole). */
export function entryText(content: string, anchor: string): string | null {
  const begin = content.indexOf(BEGIN(anchor));
  if (begin < 0) return null;
  const from = begin + BEGIN(anchor).length;
  const end = content.indexOf(END(anchor), from);
  if (end < 0) return null;
  return content.slice(from, end);
}

/** Remove an entry's block (and the separator written before it); a torn block runs to the end of the file. */
function removeBlock(path: string, anchor: string, prefix: number): void {
  const content = readText(path);
  if (content === null) return;
  const begin = content.indexOf(BEGIN(anchor));
  if (begin < 0) return;
  const endAt = content.indexOf(END(anchor), begin);
  const stop = endAt < 0 ? content.length : endAt + END(anchor).length;
  let start = begin;
  if (prefix > 0 && begin >= prefix && /^\n+$/.test(content.slice(begin - prefix, begin))) start = begin - prefix;
  const rest = content.slice(0, start) + content.slice(stop);
  if (rest.length === 0) removeFile(path);
  else writeAtomic(path, rest);
}

function removeEntry(root: string, e: PendingEntry): void {
  const path = osPath(root, e.file);
  if (e.kind === 'document') removeFile(path);
  else removeBlock(path, e.anchor!, e.prefix);
}

export interface LeafHost {
  /** The memory folder. */
  readonly root: string;
  readonly pendingDir: string;
  /** The write transaction's connection. */
  readonly db: Db;
  /** The write's operation id (journal anchors are derived from it). */
  readonly op: string | null;
  /** Append the `leaf.recorded` event of a new reference. */
  record(ref: LeafRef): void;
}

/** The leaf writer of one write transaction. */
export class LeafWriter {
  private readonly host: LeafHost;
  private note: string | null = null;
  private readonly entries: PendingEntry[] = [];
  private entryCount = 0;

  constructor(host: LeafHost) {
    this.host = host;
  }

  private writeNote(e: PendingEntry): void {
    this.entries.push(e);
    if (this.note === null) {
      mkdirSync(this.host.pendingDir, { recursive: true });
      this.note = join(this.host.pendingDir, `${process.pid}-${Date.now()}-${randomBytes(4).toString('hex')}.json`);
    }
    writeAtomic(this.note, JSON.stringify({ op: this.host.op, entries: this.entries }));
  }

  private fileTaken(file: string, kind: LeafKind): void {
    const other = this.host.db.stmt('SELECT kind FROM leaves WHERE file = ? AND kind <> ? LIMIT 1').get(file, kind) as { kind: LeafKind } | undefined;
    if (other) throw new LedgerError('FACT_CONFLICT', `${file} is already a ${other.kind} leaf`);
    // Windows and macOS (by default) do not tell letter case apart: two such names are one file there (§3, §9).
    const alias = this.host.db.stmt('SELECT file FROM leaves WHERE file = ? COLLATE NOCASE AND file <> ? LIMIT 1').get(file, file) as { file: string } | undefined;
    if (alias) throw new LedgerError('FACT_CONFLICT', `${file} differs only in letter case from the leaf ${alias.file}: on Windows and macOS they are one file`);
  }

  /** Write a document leaf once. The same text again returns its reference; another text under the same file is refused. */
  writeDocument(file: string, text: string): LeafRef {
    checkLeafPath(file);
    if (typeof text !== 'string') throw new LedgerError('BAD_REQUEST', 'a leaf is text');
    const sha = sha256(text);
    const cur = leafRow(this.host.db, file);
    if (cur !== null) {
      if (cur.kind === 'document' && cur.sha256 === sha) return refOf(cur);
      throw new LedgerError('FACT_CONFLICT', `${file} is already recorded with other content: a document is written once (a change is a new version, a new file)`);
    }
    this.fileTaken(file, 'document');
    this.writeNote({ leaf: file, kind: 'document', file, anchor: null, prefix: 0 });
    writeAtomic(osPath(this.host.root, file), text);
    const ref: LeafRef = { leaf: file, kind: 'document', file, anchor: null, sha256: sha };
    this.host.record(ref);
    return ref;
  }

  /** Append one entry to a journal leaf; its anchor is derived from the write's operation id. */
  appendEntry(file: string, text: string): LeafRef {
    checkLeafPath(file);
    if (this.host.op === null) throw new LedgerError('BAD_REQUEST', 'a journal entry needs the write’s operation id (its anchor is derived from it)');
    if (typeof text !== 'string' || MARKER.test(text) || text.includes('\u0000')) throw new LedgerError('BAD_REQUEST', 'a journal entry is text without NUL and without the memory’s entry markers');
    const body = text.endsWith('\n') ? text : `${text}\n`;
    const anchor = `e-${sha256(`${this.host.op}\n${this.entryCount++}`).slice(0, 16)}`;
    const leaf = `${file}#${anchor}`;
    const sha = sha256(body);
    const cur = leafRow(this.host.db, leaf);
    if (cur !== null) {
      if (cur.sha256 === sha) return refOf(cur);
      throw new LedgerError('FACT_CONFLICT', `${leaf} is already recorded with other text`);
    }
    this.fileTaken(file, 'journal');
    const path = osPath(this.host.root, file);
    let content = readText(path) ?? '';
    const there = entryText(content, anchor);
    if (there === null && content.includes(BEGIN(anchor))) {
      // A torn block of an earlier attempt that never committed: remove it, then append whole.
      removeBlock(path, anchor, 0);
      content = readText(path) ?? '';
    } else if (there !== null && there !== body) {
      removeBlock(path, anchor, 0);
      content = readText(path) ?? '';
    }
    if (there === body) {
      // The same entry of an attempt that never committed: not appended again, now recorded.
      this.writeNote({ leaf, kind: 'journal', file, anchor, prefix: 0 });
    } else {
      const prefix = content.length === 0 || content.endsWith('\n\n') ? '' : content.endsWith('\n') ? '\n' : '\n\n';
      this.writeNote({ leaf, kind: 'journal', file, anchor, prefix: prefix.length });
      appendDurable(path, `${prefix}${BEGIN(anchor)}${body}${END(anchor)}`);
    }
    const ref: LeafRef = { leaf, kind: 'journal', file, anchor, sha256: sha };
    this.host.record(ref);
    return ref;
  }

  /** The write rolls back: remove what it wrote, newest first, while it still holds the lock. */
  undo(): void {
    for (const e of [...this.entries].reverse()) {
      try {
        removeEntry(this.host.root, e);
      } catch {
        /* left for the next write's cleanup: the note stays */
        return;
      }
    }
    this.dropNote();
  }

  /** The write committed: its leaves are referenced, the note goes. */
  committed(): void {
    this.dropNote();
  }

  private dropNote(): void {
    if (this.note !== null) {
      try {
        removeFile(this.note);
      } catch {
        /* the next write finds the leaves committed and drops it */
      }
    }
    this.note = null;
    this.entries.length = 0;
  }
}

/**
 * Inside a write, before anything else: every leaf a dead writer left without a
 * committed reference is removed (§3.2: "removed by the next mp call").
 * Returns how many leaves were removed.
 */
export function cleanPendingLeaves(root: string, pendingDir: string, db: Db): number {
  let names: string[];
  try {
    names = readdirSync(pendingDir).filter((n) => n.endsWith('.json'));
  } catch {
    return 0;
  }
  let removed = 0;
  for (const name of names) {
    const path = join(pendingDir, name);
    let entries: PendingEntry[] = [];
    try {
      entries = (JSON.parse(readFileSync(path, 'utf8')) as { entries: PendingEntry[] }).entries ?? [];
    } catch {
      /* a note torn by the crash itself: its leaf writes had not started */
    }
    for (const e of [...entries].reverse()) {
      if (leafRow(db, e.leaf) !== null) continue;
      // A name that is a committed leaf's in another letter case is that leaf's file on Windows and macOS:
      // a document there, or the same journal entry (same anchor), is never removed.
      if (e.kind === 'document' && db.stmt('SELECT 1 FROM leaves WHERE file = ? COLLATE NOCASE').get(e.file)) continue;
      if (e.kind === 'journal' && db.stmt('SELECT 1 FROM leaves WHERE file = ? COLLATE NOCASE AND anchor = ?').get(e.file, e.anchor)) continue;
      removeEntry(root, e);
      removed++;
    }
    removeFile(path);
  }
  return removed;
}

/** A recorded leaf as it is now: present with the recorded hash, missing, or edited. */
export function readLeaf(root: string, db: Db, leaf: string): LeafRead | null {
  const r = leafRow(db, leaf);
  if (r === null) return null;
  const ref = refOf(r);
  const content = readText(osPath(root, r.file));
  const text = content === null ? null : r.kind === 'document' ? content : entryText(content, r.anchor!);
  const status: LeafStatus = text === null ? 'missing' : sha256(text) === r.sha256 ? 'ok' : 'edited';
  return { ...ref, status, text, op: r.op, revision: Number(r.rev) as Revision };
}

/** Every recorded leaf checked (§3.3 step 5): the ids missing and edited, at most `cap` of each, and the counts. */
export function checkAllLeaves(root: string, db: Db, cap = 1000): { checked: number; missing: string[]; edited: string[]; missingCount: number; editedCount: number } {
  const out = { checked: 0, missing: [] as string[], edited: [] as string[], missingCount: 0, editedCount: 0 };
  const files = new Map<string, string | null>();
  const page = db.stmt('SELECT leaf, kind, file, anchor, sha256, op, rev FROM leaves WHERE leaf > ? ORDER BY leaf LIMIT 1000');
  for (let after = ''; ; ) {
    const rows = page.all(after) as unknown as LeafRow[];
    if (rows.length === 0) break;
    for (const r of rows) {
      after = r.leaf;
      out.checked++;
      if (!files.has(r.file)) {
        if (files.size > 256) files.clear();
        files.set(r.file, readText(osPath(root, r.file)));
      }
      const content = files.get(r.file) ?? null;
      const text = content === null ? null : r.kind === 'document' ? content : entryText(content, r.anchor!);
      if (text === null) {
        out.missingCount++;
        if (out.missing.length < cap) out.missing.push(r.leaf);
      } else if (sha256(text) !== r.sha256) {
        out.editedCount++;
        if (out.edited.length < cap) out.edited.push(r.leaf);
      }
    }
  }
  return out;
}

/** True when the memory folder has leaf notes left by a write that did not finish. */
export function hasPendingLeaves(pendingDir: string): boolean {
  if (!existsSync(pendingDir)) return false;
  try {
    return readdirSync(pendingDir).some((n) => n.endsWith('.json'));
  } catch {
    return false;
  }
}

