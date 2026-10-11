// The project folder's layout (design 4.1 §3.1) and the relative paths the
// memory stores (§9: paths are stored relative to the project folder, so a copy
// on another machine or operating system reads them unchanged).
//
// Every path the memory records is relative to `.mission-pipeline/`, uses "/",
// and is checked to be portable: segments of letters, digits, ".", "_" and "-",
// no "." or ".." segments, no Windows device names, no trailing dot.

import { join } from 'node:path';
import { LedgerError } from './errors.ts';

export const MEMORY_DIRNAME = '.mission-pipeline';
export const MEMORY_DB = 'memory.db';

/** The directories `mp init` creates (§3.1). */
export const LAYOUT_DIRS: readonly string[] = ['words', 'missions', 'roles', 'pm', 'worktrees', 'tmp', 'locks'];

/** Working areas, never leaves (§3.1). */
const WORKING_ROOTS: ReadonlySet<string> = new Set(['worktrees', 'tmp', 'locks']);

export interface MemoryPaths {
  /** The project folder. */
  readonly project: string;
  /** `<project>/.mission-pipeline`. */
  readonly root: string;
  readonly db: string;
  readonly locks: string;
  readonly tmp: string;
  readonly worktrees: string;
  /** Notes of leaf writes in progress (leaves.ts): an uncommitted write's leaves are found and removed from them. */
  readonly pendingLeaves: string;
}

export function memoryPaths(projectDir: string): MemoryPaths {
  const root = join(projectDir, MEMORY_DIRNAME);
  return {
    project: projectDir,
    root,
    db: join(root, MEMORY_DB),
    locks: join(root, 'locks'),
    tmp: join(root, 'tmp'),
    worktrees: join(root, 'worktrees'),
    pendingLeaves: join(root, 'tmp', '.leaves-pending'),
  };
}

const SEGMENT = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;
const DEVICE = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;

/** Null when `rel` is a portable relative path; else why not. */
export function relPathProblem(rel: unknown): string | null {
  if (typeof rel !== 'string' || rel.length === 0 || rel.length > 1024) return 'a path is 1 to 1024 characters';
  for (const seg of rel.split('/')) {
    if (!SEGMENT.test(seg) || seg.endsWith('.') || /^\.+$/.test(seg)) return `path segment ${JSON.stringify(seg)} is not portable (letters, digits, ".", "_", "-"; no trailing dot)`;
    if (DEVICE.test(seg)) return `path segment ${JSON.stringify(seg)} is a Windows device name`;
  }
  return null;
}

/** A leaf's path: portable, relative to the memory folder, a Markdown file outside the working areas and the database. */
export function checkLeafPath(rel: string): string {
  const bad = relPathProblem(rel);
  if (bad !== null) throw new LedgerError('BAD_REQUEST', `leaf path ${JSON.stringify(rel)}: ${bad}`);
  if (!rel.endsWith('.md')) throw new LedgerError('BAD_REQUEST', `leaf path ${JSON.stringify(rel)}: leaves are Markdown files (.md)`);
  const top = rel.split('/')[0]!;
  if (WORKING_ROOTS.has(top) || rel === MEMORY_DB) throw new LedgerError('BAD_REQUEST', `leaf path ${JSON.stringify(rel)}: ${top}/ is a working area, not memory`);
  return rel;
}

/** The operating-system path of a relative memory path. */
export function osPath(root: string, rel: string): string {
  return join(root, ...rel.split('/'));
}

/** Ids that become path segments (dispatches, missions): letters, digits and "-", 1 to 64, starting with a letter or digit. */
export const PATH_ID = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/;
