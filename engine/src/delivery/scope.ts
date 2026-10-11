// The stop scope of a delivery and of its landing (design 4.1 §6.6; v51 §6.4
// conservative scope rules): a stop refuses new delivery and landing
// authorizations within its scope, so a delivery's scope must name every
// mission whose work it carries and every capability that work may have used.
//
// - Missions: the delivering mission and the source mission of every object
//   version in the manifest. A stop on any of them covers the delivery.
// - Capabilities: the memory does not link an object version to the dispatch
//   that produced it, so they are those of every dispatch of those missions (a
//   superset of what the delivered work used). When one of those missions has
//   no recorded dispatch, the provenance is unknown and the scope is
//   conservative: every capability an active stop names is included, so such a
//   stop covers it.
// The scope is derived again inside each authorizing write (a stop committed
// while the delivery or landing was being prepared is seen there), persisted
// with the intent, and on a retry checked as the union of the stored scope and
// the one derived again.

import type { MissionId } from '../common/ids.ts';
import { activeStopScopes, assertNotStopped, stoppedFor, type Db, type ScopeTag } from '../memory/index.ts';

/** Every mission a delivery's work belongs to, and every capability it may have used. */
export interface WorkScope {
  /** The delivering mission first. */
  readonly missions: readonly string[];
  readonly capabilities: readonly string[];
}

/** The scope of work of `mission` carrying objects of `missions`, with `extra` capabilities already recorded for it. */
export function deriveScope(db: Db, mission: MissionId, missions: readonly string[] = [], extra: readonly string[] = []): WorkScope {
  const all = [...new Set([mission, ...missions])];
  const caps = new Set<string>(extra);
  let unknown = false;
  for (const m of all) {
    const rows = db.stmt('SELECT capabilities FROM dispatches WHERE mission = ?').all(m) as Array<{ capabilities: string }>;
    if (rows.length === 0) unknown = true;
    for (const r of rows) for (const c of JSON.parse(r.capabilities) as string[]) caps.add(c);
  }
  if (unknown) for (const s of activeStopScopes(db)) if (s.kind === 'capability') caps.add(s.capability);
  return { missions: all, capabilities: [...caps].sort() };
}

/** Two scopes together (a stored one and one derived again); the first one's delivering mission stays first. */
export function unionWork(a: WorkScope, b: WorkScope): WorkScope {
  return { missions: [...new Set([...a.missions, ...b.missions])], capabilities: [...new Set([...a.capabilities, ...b.capabilities])].sort() };
}

/** The stop tags of a scope: one per mission, each with every capability. */
export function scopeTags(s: WorkScope): ScopeTag[] {
  return s.missions.map((m) => ({ mission: m as MissionId, capabilities: [...s.capabilities] }));
}

/** STOPPED when an active stop covers any mission of the scope (§6.6). */
export function assertScopeNotStopped(db: Db, s: WorkScope, what: string): void {
  for (const t of scopeTags(s)) assertNotStopped(db, t, what);
}

/** True when an active stop covers any mission of the scope. */
export function scopeStopped(db: Db, s: WorkScope): boolean {
  return scopeTags(s).some((t) => stoppedFor(db, t));
}

/** A scope read back from stored JSON (an intent's details); null when it holds none. */
export function storedScope(x: unknown): WorkScope | null {
  if (x === null || typeof x !== 'object') return null;
  const s = x as { missions?: unknown; capabilities?: unknown };
  if (!Array.isArray(s.missions) || !Array.isArray(s.capabilities)) return null;
  return { missions: s.missions.filter((m): m is string => typeof m === 'string'), capabilities: s.capabilities.filter((c): c is string => typeof c === 'string') };
}

/** The scope of an intent's own tag (its mission and capabilities). */
export function tagScope(t: ScopeTag): WorkScope {
  return { missions: [t.mission], capabilities: [...t.capabilities] };
}

/** @deprecated The single-mission tag of a scope: its delivering mission. Use deriveScope and assertScopeNotStopped. */
export function workScope(db: Db, mission: MissionId, missions: readonly string[] = [], extra: readonly string[] = []): ScopeTag {
  return { mission, capabilities: [...deriveScope(db, mission, missions, extra).capabilities] };
}

/** @deprecated Two single-mission tags together. */
export function unionScope(a: ScopeTag, b: ScopeTag): ScopeTag {
  return { mission: a.mission, capabilities: [...new Set([...a.capabilities, ...b.capabilities])].sort() };
}
