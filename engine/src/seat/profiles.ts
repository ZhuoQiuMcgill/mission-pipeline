// The tool profiles of the seat-card registry (design 7.1; src/seat/cards/registry.ts) as the
// seat host applies them to ANY registered card kind:
//
//   - the card fields the host itself reads (hostCardView): the common fields every card kind
//     carries, plus the optional workspace, materials, declared commands and network allowance;
//     validated once when the card is loaded, so a card module that lacks one fails at load
//     and never mid-run;
//   - which program tools the seat gets (seatToolNames): the profile's tools; read_material
//     whenever the card lists materials (whatever the profile: a blind experiment and the
//     Crititor read materials too); request_evidence on 'read-evidence' cards and on cards that
//     allow async evidence (6.2), unless the card says allowAsyncEvidence: false;
//   - what the tool sandbox holds (sandboxPaths): nothing at all for 'materials' (no file tool,
//     no shell: no sandbox is started); the snapshot read-only for 'read', 'read-evidence' and
//     'read-web'; plus scratch copies for 'read-rerun' (its declared commands may write there,
//     never exported); the writable paths for 'write';
//   - materials (MaterialShelf): immutable content-store documents read page by page; every
//     material is checked whole (its hash, its page count against the card) before the seat
//     starts, and re-read through the hash check on every page.

import { z } from 'zod';
import type { ContentHash } from '../common/ids.ts';
import type { ContentStore } from '../ledger/content.ts';
import { Command, Material, Workspace, commonCardFields, materialPage, materialPageCount, type MaterialRef } from './cards/common.ts';
import { TOOL_PROFILES, type ToolProfile } from './cards/registry.ts';

/** The network allowance of a 'read-web' card (researcher-reader: `network.allowed`). */
const Network = z
  .object({
    allowed: z.array(z.string()),
    /** Optional per-card caps; the host's defaults apply otherwise (seat/web.ts WEB_DEFAULTS). */
    maxBytes: z.number().int().positive().optional(),
    timeoutMs: z.number().int().positive().optional(),
  })
  .passthrough();

/** What the host reads of any card kind (the kind's own schema has already parsed the card). */
const HostCardSchema = z
  .object({
    ...commonCardFields,
    seat: z.string().min(1),
    workspace: Workspace.optional(),
    materials: z.array(Material).optional(),
    declaredCommands: z.array(Command).optional(),
    network: Network.optional(),
  })
  .passthrough();

export type HostCard = z.infer<typeof HostCardSchema>;
export type HostWorkspace = z.infer<typeof Workspace>;
export type DeclaredCommand = z.infer<typeof Command>;

/** The host's view of a parsed card, or throws (a card module without the common fields is a program defect). */
export function hostCardView(card: { readonly seat: string }): HostCard {
  const r = HostCardSchema.safeParse(card);
  if (!r.success) {
    throw new Error(`the ${card.seat} card lacks fields the seat host needs: ${r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  }
  return r.data;
}

/** Async evidence (6.2): a 'read-evidence' seat may ask unless its card says no; any card may allow it. */
export function asyncEvidenceAllowed(profile: ToolProfile, card: Pick<HostCard, 'allowAsyncEvidence'>): boolean {
  if (card.allowAsyncEvidence === true) return true;
  return profile === 'read-evidence' && card.allowAsyncEvidence !== false;
}

/** The program tools a seat gets (bare names; submit_result last but one when request_evidence follows). */
export function seatToolNames(profile: ToolProfile, card: Pick<HostCard, 'allowAsyncEvidence' | 'materials'>): string[] {
  const names = TOOL_PROFILES[profile].filter((n) => n !== 'request_evidence' && n !== 'submit_result');
  if ((card.materials?.length ?? 0) > 0 && !names.includes('read_material')) names.push('read_material');
  names.push('submit_result');
  if (asyncEvidenceAllowed(profile, card)) names.push('request_evidence');
  return names;
}

/** File tools need a sandbox; the 'materials' profile has none. */
export function needsSandbox(profile: ToolProfile): boolean {
  return profile !== 'materials';
}

/**
 * The sandbox's mounts for a profile: the snapshot always read-only; writable copies only of
 * the writable paths ('write') or the scratch paths of rerun commands ('read-rerun').
 */
export function sandboxPaths(profile: ToolProfile, card: Pick<HostCard, 'seat' | 'workspace'>): { readonly snapshot: string; readonly writablePaths: readonly string[]; readonly mountPoint?: string } | null {
  if (!needsSandbox(profile)) return null;
  const w = card.workspace;
  if (w === undefined) throw new Error(`the ${card.seat} card has tool profile ${profile} but no workspace (snapshot) to read`);
  const writablePaths = profile === 'write' ? w.writablePaths : profile === 'read-rerun' ? (w.scratchPaths ?? []) : [];
  return { snapshot: w.snapshot, writablePaths, ...(w.mountPoint !== undefined ? { mountPoint: w.mountPoint } : {}) };
}

/** The key the host records when a page is read (same as cards/common.ts materialPageKey). */
export const pageKey = (material: string, page: number): string => `${material}#${page}`;

/** The refusal line for a must-read page not read (the same words as the card modules use). */
export const unreadLine = (key: string): string => `must-read page ${key} was not read`;

/**
 * The card's materials (7.1 "材料工具"): immutable pointers into the content store, read page
 * by page. check() is run before the seat starts; page() re-reads through the hash check.
 */
export class MaterialShelf {
  private readonly content: ContentStore;
  readonly materials: readonly MaterialRef[];
  constructor(content: ContentStore, materials: readonly MaterialRef[]) {
    this.content = content;
    this.materials = materials;
  }

  /** Problems that make the materials unusable (empty: every material is whole and paged as the card says). */
  check(): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    for (const m of this.materials) {
      if (seen.has(m.id)) out.push(`material id ${m.id} appears twice on the card`);
      seen.add(m.id);
      let doc: string;
      try {
        doc = this.content.get(m.ref as ContentHash).toString('utf8');
      } catch (e) {
        out.push(`material ${m.id} (${m.ref}): ${(e as Error).message}`);
        continue;
      }
      const pages = materialPageCount(doc);
      if (pages !== m.pages) out.push(`material ${m.id} (${m.ref}) has ${pages} page${pages === 1 ? '' : 's'}, the card says ${m.pages}`);
    }
    return out;
  }

  /** One page as the seat sees it, or why it cannot be read. */
  page(id: string, page: number): { readonly ok: true; readonly key: string; readonly text: string } | { readonly ok: false; readonly message: string; readonly broken?: string } {
    const m = this.materials.find((x) => x.id === id);
    if (m === undefined) return { ok: false, message: `"${id}" is not a material on the card (materials: ${this.materials.map((x) => x.id).join(', ') || 'none'})` };
    if (!Number.isInteger(page) || page < 1 || page > m.pages) return { ok: false, message: `material ${id} has page${m.pages === 1 ? ' 1' : `s 1 to ${m.pages}`}; there is no page ${page}` };
    let doc: string;
    try {
      doc = this.content.get(m.ref as ContentHash).toString('utf8');
    } catch (e) {
      return { ok: false, message: `material ${id} cannot be read now; hand back what you can and say so`, broken: `material ${id} (${m.ref}): ${(e as Error).message}` };
    }
    const head = `[${m.id}] ${m.title}: page ${page} of ${m.pages}${m.mustRead ? ' (must read)' : ''}`;
    return { ok: true, key: pageKey(m.id, page), text: `${head}\n${materialPage(doc, page)}` };
  }

  /** Must-read pages not read yet, as refusal lines. */
  unread(read: ReadonlySet<string>): string[] {
    const out: string[] = [];
    for (const m of this.materials) {
      if (!m.mustRead) continue;
      for (let p = 1; p <= m.pages; p++) if (!read.has(pageKey(m.id, p))) out.push(unreadLine(pageKey(m.id, p)));
    }
    return out;
  }
}
