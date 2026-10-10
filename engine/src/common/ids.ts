// Branded identifiers. Paths, hashes and ids are distinct types (design 9.1):
// nothing is guessed from string length, which is how 3.0 misread a 64-char
// path as a blob id (DIVRA D2).

import { createHash } from 'node:crypto';

declare const brand: unique symbol;
export type Brand<T, B extends string> = T & { readonly [brand]: B };

/** Ledger revision: the sequence number of a committed base record. */
export type Revision = Brand<number, 'Revision'>;
/** Hex sha256 of content in the content store. */
export type ContentHash = Brand<string, 'ContentHash'>;
/** Business identity of a request; deduplicates retries (6.1). */
export type OpId = Brand<string, 'OpId'>;
/** One launch of an execution unit; fences late results (6.3). */
export type LaunchId = Brand<string, 'LaunchId'>;
/** Scheduler generation; fences writes from an old scheduler (6.3). */
export type Generation = Brand<number, 'Generation'>;

export type MissionId = Brand<string, 'MissionId'>;
export type ModuleId = Brand<string, 'ModuleId'>;

/** A root that later versions can revise or withdraw: requirement item, authorization quote, project constraint, standard. */
export type BasisLineId = Brand<string, 'BasisLineId'>;
export type BasisVersionId = Brand<string, 'BasisVersionId'>;

/** One immutable version of a checked object: product, interface, plan, exploration interpretation (5.1). */
export type ObjectVersionId = Brand<string, 'ObjectVersionId'>;
export type ProofUnitId = Brand<string, 'ProofUnitId'>;
export type EvidenceId = Brand<string, 'EvidenceId'>;
export type JudgmentId = Brand<string, 'JudgmentId'>;
export type EnvLineId = Brand<string, 'EnvLineId'>;
export type EnvSnapshotId = Brand<string, 'EnvSnapshotId'>;
export type IssueId = Brand<string, 'IssueId'>;
export type StopId = Brand<string, 'StopId'>;
export type EpisodeBatchId = Brand<string, 'EpisodeBatchId'>;
/** One command run inside a unit's tool sandbox (7.1). */
export type RunId = Brand<string, 'RunId'>;
/** A git object id (hex sha1 or sha256, per the repository's object format). */
export type GitOid = Brand<string, 'GitOid'>;
/** A spend reservation made by the metering proxy before forwarding a model request (6.5). */
export type ReservationId = Brand<string, 'ReservationId'>;
/** A system alert (3.9). */
export type AlertId = Brand<string, 'AlertId'>;

export function revision(n: number): Revision {
  if (!Number.isSafeInteger(n) || n < 0) throw new RangeError(`bad revision ${n}`);
  return n as Revision;
}

const HEX64 = /^[0-9a-f]{64}$/;
export function contentHash(s: string): ContentHash {
  if (!HEX64.test(s)) throw new TypeError(`not a sha256 hex digest: ${JSON.stringify(s)}`);
  return s as ContentHash;
}

/** Ids are opaque, non-empty, printable, without path separators. */
const ID = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,199}$/;
export function id<T extends Brand<string, string>>(s: string): T {
  if (!ID.test(s)) throw new TypeError(`bad id: ${JSON.stringify(s)}`);
  return s as T;
}

/**
 * Mission ids (review r1 #17): 1 to 64 letters, digits and "-", starting with a letter or digit;
 * no ".". Every global id the flows derive starts with the mission followed by ".", so a mission
 * without dots keeps them injective ("a.b" + "c" and "a" + "b.c" can never meet). "_" is left out
 * too: ledger ids (ID above) have no "_", and safeId turns it into "-", so "a_b" would meet "a-b".
 */
export const MISSION_ID = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/;

/** True when `s` is well-formed UTF-16, without lone surrogates (String.prototype.isWellFormed, Node 20+). */
export function wellFormed(s: string): boolean {
  return (s as unknown as { isWellFormed(): boolean }).isWellFormed();
}

/** Longest encoded id part kept readable; a longer one (and the empty string) is hashed. */
export const ID_PART_MAX = 64;

/**
 * One free-form local part of a derived id (task, standard, command, exploration, legalization
 * id), encoded injectively by construction (review r2): letters and digits stay; every other UTF-8
 * byte, "-" included, becomes "-" and two lowercase hex digits ("E1" -> "E1", "a-b" -> "a-2db",
 * "a.b" -> "a-2eb"). Every "-" of an encoded part is followed by two hex digits, so it decodes
 * uniquely and never holds "."; a raw id can no longer equal another id's encoding. A part longer
 * than ID_PART_MAX, or empty, becomes its escaped head, "-zz" and 16 hex of the input's sha256:
 * "z" is no hex digit, so no escaped part contains "-zz", and hashed parts never meet escaped ones.
 */
export function idPart(x: string): string {
  // a lone surrogate has no UTF-8 form of its own: "\ud800" and "\ud801" would both be U+FFFD (review r3)
  if (!wellFormed(x)) throw new Error(`id ${JSON.stringify(x)} is not well-formed text (it holds a lone UTF-16 surrogate)`);
  let out = '';
  for (const b of Buffer.from(x, 'utf8')) {
    const alnum = (b >= 0x30 && b <= 0x39) || (b >= 0x41 && b <= 0x5a) || (b >= 0x61 && b <= 0x7a);
    out += alnum ? String.fromCharCode(b) : `-${b.toString(16).padStart(2, '0')}`;
  }
  if (out.length > 0 && out.length <= ID_PART_MAX) return out;
  let head = out.slice(0, 40);
  const cut = head.lastIndexOf('-');
  if (cut >= 0 && cut > head.length - 3) head = head.slice(0, cut); // no half escape before the marker
  return `${head}-zz${createHash('sha256').update(x, 'utf8').digest('hex').slice(0, 16)}`;
}

/**
 * Requirement item and project constraint ids (review r2, r3): 1 to 64 letters, digits and "-",
 * starting with a letter or digit. They go into their lines as they are ("item.<mission>.<id>",
 * "constraint.<id>"), and a version adds ".v<n>…", so no "." and nothing safeId would rewrite.
 */
export const ITEM_ID = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/;

/** Null when `m` is a valid mission id; else why not. */
export function missionIdProblem(m: unknown): string | null {
  if (typeof m === 'string' && MISSION_ID.test(m)) return null;
  return `mission id ${JSON.stringify(m)} is not allowed: use 1 to 64 letters, digits or "-", starting with a letter or digit (no "." or "_": derived ids join their parts with ".")`;
}
