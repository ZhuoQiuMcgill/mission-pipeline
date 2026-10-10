// The seat-card registry (design 2, 7.1, 9.3): every card kind the seat host can run, with
//   schema        the card (zod; required inputs are the non-optional fields)
//   resultShape   the raw zod shape of the submit_result tool (the SDK tool takes a raw shape)
//   resultSchema  the same as an object schema
//   definition    the one-page definition: the seat's system prompt
//   toolProfile   which program tools the seat gets (7.1 table; see TOOL_PROFILES)
//   render        the card as the seat's first message
//   problems      the program's rules on a hand-back (empty: acceptable); the host refuses
//                 the hand-back and tells the seat what to fix, as it does today
//   records       the proof-model records the accepted hand-back becomes (5.2, 10.1: judgments,
//                 object versions, issues), submitted by the host as pending results under the
//                 launch so acceptance, fencing and the continuation check apply to them
//
// Constructor and Reviewer keep their definitions in src/seat/card.ts and src/seat/results.ts;
// their entries here only point at them (the host keeps building the Reviewer's judgment and
// findings itself, so their `records` is empty).
//
// The registry itself (no card module imported here, so card modules can register without an
// import cycle). src/seat/cards/index.ts imports every card module and re-exports this.

import type { z } from 'zod';
import type { LaunchId } from '../../common/ids.ts';
import type { BaseRecord, ListRef } from '../../common/records.ts';
import type { SnapshotFiles } from '../results.ts';
import { zodProblems } from './common.ts';

/**
 * The tool profiles of 7.1. Every profile also has submit_result.
 *   materials      read_material (paged, immutable pointers; must-read list enforced). No file tool, no shell. (Calibrator, Secretary)
 *   read           read_file, list_directory, search_content on the card's snapshot. (Architect, Researcher interpretation)
 *   read-rerun     read + rerun_declared_command (only the card's declared commands). (Reviewer, Auditor)
 *   read-evidence  read + request_evidence (async evidence, 6.2). (Researcher author, Crititor)
 *   read-web       read + fetch_url (only the card's allowed addresses, fetched by the program outside the sandbox). (reading investigation)
 *   write          read + write_file, edit_file (writable paths only), run_command. (Constructor, blind experiment)
 */
export type ToolProfile = 'materials' | 'read' | 'read-rerun' | 'read-evidence' | 'read-web' | 'write';

export const TOOL_PROFILES: Readonly<Record<ToolProfile, readonly string[]>> = {
  materials: ['read_material', 'submit_result'],
  read: ['read_file', 'list_directory', 'search_content', 'submit_result'],
  'read-rerun': ['read_file', 'list_directory', 'search_content', 'rerun_declared_command', 'submit_result'],
  'read-evidence': ['read_file', 'list_directory', 'search_content', 'request_evidence', 'submit_result'],
  'read-web': ['read_file', 'list_directory', 'search_content', 'fetch_url', 'submit_result'],
  write: ['read_file', 'list_directory', 'search_content', 'write_file', 'edit_file', 'run_command', 'submit_result'],
};

/** The seats of design 2 (model_config.json keys). */
export type SeatName = 'calibrator' | 'architect' | 'secretary' | 'constructor' | 'reviewer' | 'researcher' | 'crititor' | 'auditor';

/** What the program checks a hand-back against besides the card. */
export interface CardResultContext {
  /** Read-only snapshot seats: the snapshot, for file pointers. */
  readonly snapshot?: SnapshotFiles;
  /** Material seats: the pages read so far, as `${material}#${page}` keys. */
  readonly materialsRead?: ReadonlySet<string>;
}

/** What building the result's records needs. */
export interface CardRecordContext {
  readonly launch: LaunchId;
  /** read-web seats: the pages the program fetched for the seat (the host passes them), so records can cite them. */
  readonly webFetches?: ReadonlyArray<{ readonly url: string; readonly finalUrl: string; readonly status: number; readonly bytes: number; readonly truncated: boolean; readonly record: string }>;
  readonly content: { put(doc: string): string; putList(items: readonly string[]): ListRef; getList(ref: ListRef): string[] };
}

/** One card kind. `C` is the card, `R` the hand-back. */
export interface SeatCardEntry<C extends { readonly seat: string } = { readonly seat: string }, R = unknown> {
  /** The card's `seat` field value (the card kind). */
  readonly kind: string;
  /** The seat (model configuration key, 9.4). */
  readonly seat: SeatName;
  readonly schema: z.ZodType<C>;
  readonly resultShape: z.ZodRawShape;
  readonly resultSchema: z.ZodType<R>;
  readonly definition: string;
  readonly toolProfile: ToolProfile;
  /** The seat's writable paths are exported as its product (the host stores the export; Constructor-like seats). Default false. */
  readonly exportsProduct?: boolean;
  render(card: C): string;
  problems(card: C, result: R, ctx: CardResultContext): string[];
  records(card: C, result: R, ctx: CardRecordContext): BaseRecord[];
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyEntry = SeatCardEntry<any, any>;

const REGISTRY = new Map<string, AnyEntry>();

/** Register a card kind (once; a second registration of the same kind is a program defect). */
export function registerSeatCard<C extends { readonly seat: string }, R>(entry: SeatCardEntry<C, R>): void {
  const known = REGISTRY.get(entry.kind);
  if (known !== undefined && known !== entry) throw new Error(`seat card kind ${entry.kind} is registered twice`);
  REGISTRY.set(entry.kind, entry as AnyEntry);
}

/** The entry of a card kind, or throws. */
export function seatCardEntry(kind: string): AnyEntry {
  const e = REGISTRY.get(kind);
  if (e === undefined) throw new Error(`unknown seat card kind ${JSON.stringify(kind)}`);
  return e;
}

export function seatCardKinds(): string[] {
  return [...REGISTRY.keys()].sort();
}

/** A card of any registered kind, parsed by its kind's schema. */
export function parseAnyCard(x: unknown): { readonly seat: string } & Record<string, unknown> {
  const kind = (x as { seat?: unknown } | null)?.seat;
  if (typeof kind !== 'string') throw new Error('a card names its kind in "seat"');
  return seatCardEntry(kind).schema.parse(x) as { readonly seat: string } & Record<string, unknown>;
}

/** The hand-back's problems: its shape first, then the kind's own rules. */
export function handBackProblems(card: { readonly seat: string }, raw: unknown, ctx: CardResultContext): string[] {
  const e = seatCardEntry(card.seat);
  const r = e.resultSchema.safeParse(raw);
  if (!r.success) return zodProblems(r.error);
  return e.problems(card, r.data, ctx);
}

/** The accepted hand-back's records (pending results under the launch). */
export function handBackRecords(card: { readonly seat: string }, raw: unknown, ctx: CardRecordContext): BaseRecord[] {
  const e = seatCardEntry(card.seat);
  return e.records(card, e.resultSchema.parse(raw), ctx);
}

