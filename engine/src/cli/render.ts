// Small text helpers for the CLI's human-readable output (design 4.1 §4.1: text for people,
// `--json` for programs).

import type { Filler } from '../memory/index.ts';
import type { Problem } from './project.ts';
import { wiRef } from './wi.ts';

export function filler(f: Filler | null | undefined): string {
  if (f === null || f === undefined) return 'unknown filler';
  return f.model === null ? f.harness : `${f.harness}/${f.model}`;
}

export function age(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 90) return `${s} s`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m} min`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} h`;
  return `${Math.round(h / 24)} d`;
}

export function short(sha: string | null | undefined): string {
  if (sha === null || sha === undefined) return '-';
  return /^[0-9a-f]{40,64}$/.test(sha) ? sha.slice(0, 12) : sha;
}

export function clip(s: string, n = 160): string {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length <= n ? one : `${one.slice(0, n - 1)}…`;
}

/** "WI-06 <title> (page: ...)" or the bare number for a WI without a page. */
export function wiText(wi: string | null | undefined, projectDir: string | null): string | null {
  if (wi === null || wi === undefined) return null;
  return wiRef(wi, projectDir) ?? wi;
}

/** The problems an `mp` command found before its own answer, as text lines. */
export function problemLines(problems: readonly Problem[], projectDir: string | null): string[] {
  return problems.map((p) => `! ${p.message}${p.wi !== null ? ` [${wiText(p.wi, projectDir)}]` : ''}`);
}

export function section(title: string, lines: readonly string[], empty?: string): string[] {
  if (lines.length === 0) return empty === undefined ? [] : [`${title}: ${empty}`];
  return [`${title}:`, ...lines.map((l) => `  ${l}`)];
}
