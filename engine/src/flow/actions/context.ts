// What the program actions of the flows share (design 7.1, 6.5, 4.1, 4.2): the project
// repository through the safe git wrapper, the bound transform description, the program's work
// directory on a Linux filesystem, the content store the seat exports are in, the ledger port
// the product versions and evidence go to, and the disk admission of every write (6.5).

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { MissionId } from '../../common/ids.ts';
import type { FsProbe, FsStats, LedgerReserve } from '../../git/admission.ts';
import type { Ident, RepoLayout } from '../../git/objects.ts';
import { AttributeEvaluator, type TransformDescription } from '../../git/representation.ts';
import type { SafeGit } from '../../git/safeGit.ts';
import type { FlowLedgerPort } from '../ports.ts';

/** Reading stored seat exports (src/seat/tree.ts tree documents): the content store. */
export interface ExportStore {
  get(hash: string): Buffer;
}

export interface ActionContext {
  readonly git: SafeGit;
  /** The project repository (never written except new objects: blobs, trees, commits). */
  readonly repo: RepoLayout;
  /** The bound transform description (7.1): read at install or mission start, never re-read silently. */
  readonly description: TransformDescription;
  /** The program's work directory for snapshots, product candidates and verification jobs (Linux filesystem, 6.1). */
  readonly workDir: string;
  /** Where the seat hosts stored the exports. */
  readonly exports: ExportStore;
  /** Product versions and evidence records go here (with the documents they name). */
  readonly ledger: FlowLedgerPort;
  /** The commit a mission's work starts from (its base). */
  readonly base: (mission: MissionId) => Promise<string>;
  /** Paths a seat never sees (7.1: project instruction files); default DEFAULT_EXCLUDE. */
  readonly exclude?: (path: string) => boolean;
  /** 6.5: commit generation is a write, admitted per destination. */
  readonly disk: { readonly reserve: LedgerReserve; readonly sharesVolume: (fs: FsStats) => boolean; readonly probe?: FsProbe };
  /** Author and committer of the commits the program generates. */
  readonly ident: Ident;
}

/** 7.1: the project instruction files a seat must not read (they are not in any snapshot). */
export function DEFAULT_EXCLUDE(path: string): boolean {
  const base = path.split('/').at(-1) ?? path;
  return base === 'CLAUDE.md' || base === 'CLAUDE.local.md' || base === 'AGENTS.md' || path === '.claude' || path.startsWith('.claude/');
}

/** A refusal of a program action the caller can act on; `code` names what happened. */
export class ActionError extends Error {
  readonly code: 'product-rejected' | 'not-admitted' | 'conflict' | 'missing-objects' | 'unknown-product' | 'unsafe-path' | 'verification-failed';
  readonly detail: unknown;
  constructor(code: ActionError['code'], message: string, detail: unknown = null) {
    super(message);
    this.code = code;
    this.detail = detail;
  }
}

const evaluators = new WeakMap<ActionContext, Promise<AttributeEvaluator>>();

/** The attribute evaluator under the bound description (one per context; a scratch repository under the work directory). */
export function attributesOf(ctx: ActionContext): Promise<AttributeEvaluator> {
  let a = evaluators.get(ctx);
  if (a === undefined) {
    const scratch = join(ctx.workDir, 'attributes');
    mkdirSync(scratch, { recursive: true });
    a = AttributeEvaluator.create(ctx.git, ctx.repo, ctx.description, scratch);
    evaluators.set(ctx, a);
  }
  return a;
}

export function excludeOf(ctx: ActionContext): (path: string) => boolean {
  return ctx.exclude ?? DEFAULT_EXCLUDE;
}
