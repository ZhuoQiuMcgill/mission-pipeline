// 4.4 (G9): the requirement-set lines a mission's items are written into. Shared by the flow's item writes
// (flow/requirements.ts) and a supersession's withdrawal inside the memory's own transaction (memory/words.ts).
//
// `reqset.<m>`     what every PM plan is checked against (v31 5.2): the items recorded with `mp pm requirement add`,
//                  exactly as in 4.3. An item recorded by `mp pm extend` is never written into it.
// `reqnew.<m>.t<n>` the items recorded by `mp pm extend` while PM plan version n was the latest submitted: a plan
//                  submitted later binds it (it is checked against them), a plan submitted before does not.
// `reqnew.<m>`     every item recorded by `mp pm extend` in force: an audit of the whole mission binds it with
//                  `reqset.<m>`, so it goes out of date when any item changes.
// A memory with no `mp pm extend` has no `reqnew` line, and every write is 4.3's.

import type { BasisIndex } from '../../flow/context.ts';

export const requirementSetLine = (mission: string): string => `reqset.${mission}`;
export const newRequirementsLine = (mission: string): string => `reqnew.${mission}`;
export const newRequirementsTermLine = (mission: string, n: number): string => `reqnew.${mission}.t${n}`;

/** The term lines of a mission in force, oldest term first. */
export function termLines(ix: Pick<BasisIndex, 'current'>, mission: string): string[] {
  const prefix = `reqnew.${mission}.t`;
  return [...ix.current.keys()]
    .filter((l) => l.startsWith(prefix) && /^[1-9][0-9]*$/.test(l.slice(prefix.length)))
    .sort((a, b) => Number(a.slice(prefix.length)) - Number(b.slice(prefix.length)));
}

/** The item versions a requirement-set version lists (none for a line with no version). */
export function setSnapshot(ix: Pick<BasisIndex, 'current' | 'records'>, getList: (ref: never) => readonly string[], line: string): readonly string[] {
  const v = ix.current.get(line);
  const rec = v === undefined ? undefined : ix.records.get(v);
  return rec?.basisKind === 'requirement-set' ? getList(rec.snapshot as never) : [];
}

/**
 * The items ever recorded by `mp pm extend` (item line → its term line), read from every version of the term lines (p12-5:
 * an item withdrawn since is still one of them, so no write ever puts it into `reqset.<m>`).
 */
export function newItemTerms(ix: BasisIndex, getList: (ref: never) => readonly string[], mission: string): Map<string, string> {
  const out = new Map<string, string>();
  const terms = new Set(termLines(ix, mission));
  for (const rec of ix.records.values()) {
    if (rec.basisKind !== 'requirement-set' || !terms.has(rec.line)) continue;
    for (const v of getList(rec.snapshot as never)) { const l = ix.lineOf.get(v); if (l !== undefined && !out.has(l)) out.set(l, rec.line); }
  }
  return out;
}

/** The next version id of a requirement-set line (`<line>.v<n>`). */
export function nextSetVersion(ix: Pick<BasisIndex, 'current'>, line: string): string {
  const prev = ix.current.get(line);
  return `${line}.v${prev === undefined ? 1 : Number(prev.slice(prev.lastIndexOf('.v') + 2)) + 1}`;
}

export interface SetVersion {
  readonly line: string;
  readonly version: string;
  /** The item versions it lists, sorted. */
  readonly snapshot: readonly string[];
}

/**
 * The requirement-set versions one item write makes: `line` gets `version` (null: it is withdrawn). An item recorded by
 * `mp pm extend` (an item of a term line now, or a new one with `term`) is written into its term line and `reqnew.<m>`;
 * any other into `reqset.<m>`, listing the items in force outside the terms, as 4.3 lists every item in force.
 */
export function setVersionsFor(
  ix: BasisIndex,
  getList: (ref: never) => readonly string[],
  mission: string,
  change: { readonly line: string; readonly version: string | null; readonly term?: string },
  inForce: ReadonlyArray<{ readonly line: string; readonly version: string }>,
): SetVersion[] {
  const terms = newItemTerms(ix, getList, mission);
  const term = terms.get(change.line) ?? change.term;
  const replace = (versions: readonly string[]): string[] => [...versions.filter((v) => ix.lineOf.get(v) !== change.line), ...(change.version !== null ? [change.version] : [])].sort();
  if (term === undefined) {
    const line = requirementSetLine(mission);
    const items = inForce.filter((i) => i.line !== change.line && !terms.has(i.line)).map((i) => i.version);
    return [{ line, version: nextSetVersion(ix, line), snapshot: [...items, ...(change.version !== null ? [change.version] : [])].sort() }];
  }
  const all = newRequirementsLine(mission);
  return [
    { line: term, version: nextSetVersion(ix, term), snapshot: replace(setSnapshot(ix, getList, term)) },
    { line: all, version: nextSetVersion(ix, all), snapshot: replace(setSnapshot(ix, getList, all)) },
  ];
}
