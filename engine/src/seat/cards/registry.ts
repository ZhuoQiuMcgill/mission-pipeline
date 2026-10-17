// The seat-card registry (design 4.1 §5.2; 4.0 2, 7.1, 9.3): every card kind `mp` can
// dispatch, with
//   schema        the card (zod; required inputs are the non-optional fields)
//   resultShape   the raw zod shape of the structured hand-back fields (the card prints their JSON schema)
//   resultSchema  the same as an object schema
//   seat          the role: its one-page description is `roles/<seat>.md` (single source, roles.ts)
//   toolProfile   which `mp seat <id>` commands the seat gets (SEAT_COMMANDS)
//   render        the card's task-specific body (src/seat/card.ts renderSeatCard adds the role
//                 page, the commands and the hand-back section)
//   problems      the program's rules on a hand-back (empty: acceptable); `mp seat <id>
//                 handback` refuses it and tells the seat what to fix
//   records       the proof-model records the accepted hand-back becomes (5.2, 10.1: judgments,
//                 object versions, issues), appended in the hand-back's own write
//
// Constructor and Reviewer keep their definitions in src/seat/card.ts and src/seat/results.ts;
// their entries here only point at them (`mp` builds the Reviewer's judgment and findings
// itself, so their `records` is empty).
//
// The registry itself (no card module imported here, so card modules can register without an
// import cycle). src/seat/cards/index.ts imports every card module and re-exports this.

import type { z } from 'zod';
import type { BaseRecord, ListRef } from '../../common/records.ts';
import type { SnapshotFiles } from '../results.ts';
import { zodProblems } from './common.ts';
import { roleText } from './roles.ts';

/**
 * The tool profiles (4.0 7.1, kept as names): which `mp seat <id>` commands a card kind gets
 * (SEAT_COMMANDS). Reading, writing, searching, running and fetching otherwise use the
 * harness's own tools.
 *   materials      materials only (Calibrator, Secretary, Stabilizer)
 *   read           checkout: the commit the card names (Architect, Researcher interpreter)
 *   read-rerun     checkout + rerun of the card's declared commands (Reviewer, Auditor)
 *   read-evidence  checkout + request-evidence (Researcher author, Crititor)
 *   read-web       checkout; pages fetched with the harness's own tools, cited url:<address> (reading investigation)
 *   write          its own worktree (Constructor), or reruns of the declared step commands (blind experiment)
 */
export type ToolProfile = 'materials' | 'read' | 'read-rerun' | 'read-evidence' | 'read-web' | 'write';

/** One `mp seat <id>` command (`full-run`: an integration task's Reviewer only, when the project declares a full suite, 4.1.2). */
export type SeatCommand = 'card' | 'read' | 'checkout' | 'rerun' | 'owners' | 'request-evidence' | 'full-run' | 'handback';

/** The commands of each profile (every seat also has `card`, `read` and `handback`). */
export const SEAT_COMMANDS: Readonly<Record<ToolProfile, readonly SeatCommand[]>> = {
  materials: ['card', 'read', 'handback'],
  read: ['card', 'read', 'checkout', 'handback'],
  'read-rerun': ['card', 'read', 'checkout', 'rerun', 'handback'],
  'read-evidence': ['card', 'read', 'checkout', 'request-evidence', 'handback'],
  'read-web': ['card', 'read', 'checkout', 'handback'],
  write: ['card', 'read', 'handback'],
};

/** The seats (their role pages are `roles/<seat>.md`). */
export type SeatName = 'calibrator' | 'architect' | 'secretary' | 'constructor' | 'reviewer' | 'researcher' | 'crititor' | 'stabilizer' | 'auditor';

/** What the program checks a hand-back against besides the card. */
export interface CardResultContext {
  /** Read-only snapshot seats: the files of the commit the card names, for file pointers. */
  readonly snapshot?: SnapshotFiles;
  /** Material seats: the pages read so far, as `${material}#${page}` keys. */
  readonly materialsRead?: ReadonlySet<string>;
  /** The runs this dispatch made with `mp seat <id> rerun`, in order (evidence ids, with whether each completed). */
  readonly runs?: ReadonlyArray<{ readonly run: string; readonly completed: boolean }>;
}

/** What building the result's records needs. */
export interface CardRecordContext {
  /** The dispatch that hands back (ids of the records it makes derive from it). */
  readonly launch: string;
  /** The runs this dispatch made with `mp seat <id> rerun` (blind experiments cite them as run:<id>). */
  readonly runs?: ReadonlyArray<{ readonly run: string; readonly completed: boolean }>;
  readonly content: { put(doc: string): string; putList(items: readonly string[]): ListRef; getList(ref: ListRef): string[] };
}

/** One card kind. `C` is the card, `R` the hand-back. */
export interface SeatCardEntry<C extends { readonly seat: string } = { readonly seat: string }, R = unknown> {
  /** The card's `seat` field value (the card kind). */
  readonly kind: string;
  /** The seat (its role page). */
  readonly seat: SeatName;
  readonly schema: z.ZodType<C>;
  readonly resultShape: z.ZodRawShape;
  readonly resultSchema: z.ZodType<R>;
  readonly toolProfile: ToolProfile;
  /** The seat works in its own worktree and hands back a candidate commit (the Constructor). Default false. */
  readonly exportsProduct?: boolean;
  render(card: C): string;
  problems(card: C, result: R, ctx: CardResultContext): string[];
  records(card: C, result: R, ctx: CardRecordContext): BaseRecord[];
}

/** A registered entry: the kind's own fields, plus its role page (loaded when read). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type RegisteredEntry = SeatCardEntry<any, any> & {
  /** The seat's one-page role description (roles/<seat>.md): the single source of every card's role text. */
  readonly definition: string;
};

const REGISTRY = new Map<string, RegisteredEntry>();

/** Register a card kind (once; a second registration of the same kind is a program defect). */
export function registerSeatCard<C extends { readonly seat: string }, R>(entry: SeatCardEntry<C, R>): void {
  const known = REGISTRY.get(entry.kind);
  if (known !== undefined) {
    if (Object.getPrototypeOf(known) === entry) return;
    throw new Error(`seat card kind ${entry.kind} is registered twice`);
  }
  const registered = Object.create(entry, { definition: { get: () => roleText(entry.seat), enumerable: true } }) as RegisteredEntry;
  REGISTRY.set(entry.kind, registered);
}

/** The entry of a card kind, or throws. */
export function seatCardEntry(kind: string): RegisteredEntry {
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

/** The accepted hand-back's records. */
export function handBackRecords(card: { readonly seat: string }, raw: unknown, ctx: CardRecordContext): BaseRecord[] {
  const e = seatCardEntry(card.seat);
  return e.records(card, e.resultSchema.parse(raw), ctx);
}
