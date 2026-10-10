// Stop requests and scopes (design 6.4): the types every stop path shares.

import type { MissionId, StopId } from '../common/ids.ts';

export type StopScope =
  | { readonly kind: 'all' }
  | { readonly kind: 'mission'; readonly mission: MissionId }
  | { readonly kind: 'capability'; readonly capability: string };

export interface StopRequest {
  readonly stop: StopId;
  readonly scope: StopScope;
  /** The user's words, kept with the restriction. */
  readonly words: string;
  readonly at: number;
}

/** What a unit or an external action touches; matched against stop scopes. */
export interface ScopeTag {
  readonly mission: MissionId;
  readonly capabilities: readonly string[];
}

export function stopCovers(scope: StopScope, tag: ScopeTag): boolean {
  switch (scope.kind) {
    case 'all':
      return true;
    case 'mission':
      return scope.mission === tag.mission;
    case 'capability':
      return tag.capabilities.includes(scope.capability);
  }
}

/** A stop scope lies within another (6.4 "再收窄": only ever narrower). */
export function scopeWithin(inner: StopScope, outer: StopScope): boolean {
  if (outer.kind === 'all') return true;
  if (outer.kind === 'mission') return inner.kind === 'mission' && inner.mission === outer.mission;
  return inner.kind === 'capability' && inner.capability === outer.capability;
}

/** Two tags name the same scope: the same mission and the same set of capabilities. */
export function sameTag(a: ScopeTag, b: ScopeTag): boolean {
  if (a.mission !== b.mission) return false;
  const x = [...new Set(a.capabilities)].sort();
  const y = [...new Set(b.capabilities)].sort();
  return x.length === y.length && x.every((c, i) => c === y[i]);
}

const ID = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,199}$/;

/** Check one request strictly; anything else is not a stop (and could not be committed). */
export function checkStopRequest(r: unknown): StopRequest | null {
  if (!r || typeof r !== 'object') return null;
  const o = r as Record<string, unknown>;
  if (typeof o.stop !== 'string' || !ID.test(o.stop)) return null;
  if (typeof o.words !== 'string' || o.words.length > 64 * 1024) return null;
  if (typeof o.at !== 'number' || !Number.isSafeInteger(o.at) || o.at < 0) return null;
  const sc = o.scope as Record<string, unknown> | null;
  if (!sc || typeof sc !== 'object') return null;
  let scope: StopScope;
  if (sc.kind === 'all') scope = { kind: 'all' };
  else if (sc.kind === 'mission' && typeof sc.mission === 'string' && ID.test(sc.mission)) scope = { kind: 'mission', mission: sc.mission as MissionId };
  else if (sc.kind === 'capability' && typeof sc.capability === 'string' && sc.capability.length > 0 && sc.capability.length <= 200) {
    scope = { kind: 'capability', capability: sc.capability };
  } else return null;
  return { stop: o.stop as StopId, scope, words: o.words, at: o.at };
}

export function parseStopRequest(raw: string): StopRequest | null {
  try {
    return checkStopRequest(JSON.parse(raw));
  } catch {
    return null;
  }
}
