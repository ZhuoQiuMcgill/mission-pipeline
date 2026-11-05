// Shared resolvers for the flow and dispatch-time card refresh.
import type { BaseRecord, BasisVersionRecord, ConstraintScope, ObjectScope } from '../../common/records.ts';
import type { BasisIndex } from '../../flow/context.ts';
import type { CurrentItem, ItemVersionBody, ConstraintBody } from '../../flow/requirements.ts';
import type { FlowEvent } from '../../flow/ports.ts';

export function resolveBases(records: readonly BaseRecord[]): BasisIndex {
  const current = new Map<string, string>();
  const lineOf = new Map<string, string>();
  const versions = new Map<string, BasisVersionRecord>();
  const withdrawn = new Set<string>();
  for (const r of records) {
    if (r.kind === 'basis.version') { current.set(r.line, r.version); lineOf.set(r.version, r.line); versions.set(r.version, r); }
    if (r.kind === 'basis.withdrawn') withdrawn.add(r.line);
  }
  return { current, lineOf, records: versions, withdrawn };
}

export function resolveItems(ix: BasisIndex, events: readonly FlowEvent[]): CurrentItem[] {
  const latest = new Map<string, ItemVersionBody>();
  const contested = new Set<string>();
  for (const e of events) {
    if (e.line !== 'requirements') continue;
    if (e.event === 'item') { const b = e.body as ItemVersionBody; latest.set(b.line, b); }
    if (e.event === 'contested') { const b = e.body as { line: string; contested: boolean }; if (b.contested) contested.add(b.line); else contested.delete(b.line); }
  }
  return [...latest.values()].filter((b) => !ix.withdrawn.has(b.line) && ix.current.get(b.line) === b.version)
    .map((b) => ({ ...b, state: contested.has(b.line) ? 'contested' : 'valid' }));
}

export function resolveConstraints(ix: BasisIndex, events: readonly FlowEvent[]): ConstraintBody[] {
  const latest = new Map<string, { body: ConstraintBody; revision: number }>();
  for (const e of events) {
    if (e.line !== 'requirements') continue;
    if (e.event === 'constraint') {
      const b = e.body as ConstraintBody;
      if (ix.current.get(b.line) === b.version && !ix.withdrawn.has(b.line)) latest.set(b.line, { body: b, revision: e.revision });
    }
    if (e.event === 'constraint-scope') {
      const b = e.body as { line: string; version: string; scope: ConstraintBody['scope'] };
      const prior = latest.get(b.line);
      if (prior !== undefined && e.revision > prior.revision) latest.set(b.line, { body: { ...prior.body, scope: b.scope }, revision: e.revision });
    }
  }
  return [...latest.values()].map((x) => x.body);
}

/** The path patterns constraintApplies reads (4.1.3, #36), in words for a refusal. */
export const CONSTRAINT_PATTERN_FORMS = '"**" (every path), an exact path such as "src/app.ts", or a folder and everything under it such as "docs/reports/**"';

/** A glob wildcard ("[", "{" and "!" are left alone: they occur in real file names, such as "pages/[id].tsx"). */
const WILDCARD = /[*?]/;

/**
 * Why constraintApplies cannot read a scope path pattern, with the nearest form it reads (4.1.3, #36:
 * "docs/reports/Report_Batch_*" matched nothing, silently); null when it reads it. The matcher is not
 * extended with globs: the three forms cover the field's cases, and overlap between glob sets is hard.
 */
export function constraintPatternProblem(pattern: string): { readonly problem: string; readonly suggestion: string } | null {
  if (pattern === '**') return null;
  const clean = pattern.replace(/\\/g, '/').trim().replace(/^(\.\/)+/, '').replace(/^\/+/, '').replace(/\/{2,}/g, '/');
  const segments = clean.split('/').filter((s) => s !== '' && s !== '.');
  const folder = (segs: readonly string[]): string => (segs.length === 0 ? '**' : `${segs.join('/')}/**`);
  const firstWild = segments.findIndex((s) => WILDCARD.test(s));
  // the nearest form: the folder above the first segment with a wildcard, or the path as it is
  const nearest = (): string => {
    if (firstWild >= 0) return folder(segments.slice(0, firstWild).filter((s) => s !== '..'));
    if (segments.includes('..')) return folder([]);
    return clean.endsWith('/') ? folder(segments) : segments.join('/');
  };
  if (pattern.trim() === '') return { problem: 'the pattern is empty', suggestion: '**' };
  if (pattern !== pattern.trim()) return { problem: 'the pattern has spaces around it', suggestion: nearest() };
  if (pattern.includes('\\')) return { problem: 'the pattern uses "\\"; paths use "/"', suggestion: nearest() };
  if (pattern.startsWith('/') || pattern.startsWith('./')) return { problem: 'the pattern is not relative to the repository root as the paths are ("src/app.ts", not "/src/app.ts" or "./src/app.ts")', suggestion: nearest() };
  if (segments.includes('..') || pattern.includes('//') || pattern.split('/').includes('.')) return { problem: 'the pattern has an empty, "." or ".." segment', suggestion: nearest() };
  if (pattern.endsWith('/**') && !WILDCARD.test(pattern.slice(0, -3))) return null;
  if (firstWild >= 0) return { problem: `"${segments[firstWild]}" is a wildcard; the matcher reads no wildcard except a final "/**", so this scope would match nothing`, suggestion: nearest() };
  if (pattern.endsWith('/')) return { problem: 'a folder is written with "/**" after it', suggestion: nearest() };
  return null;
}

/** Applicability belongs to the object (each proof-unit member has its own mission). */
export function constraintApplies(c: { readonly scope: ConstraintScope }, obj: { readonly scope: ObjectScope; readonly mission: string }): boolean {
  return (c.scope.mission === undefined || c.scope.mission === obj.mission)
    && (c.scope.taskTypes.length === 0 || c.scope.taskTypes.includes(obj.scope.taskType))
    && obj.scope.paths.some((path) => c.scope.paths.some((pattern) => pattern === '**' || pattern === path || (pattern.endsWith('/**') && (path === pattern.slice(0, -3) || path.startsWith(pattern.slice(0, -2))))));
}

/** A withdrawn constraint keeps its full history; the label path removes its proof duty. */
export async function withdrawConstraint(ports: import('../../flow/ports.ts').FlowPorts, req: { constraint: string; words: string }): Promise<void> {
  const { basisIndex, flowCtx, commit, ev } = await import('../../flow/context.ts');
  const { constraintLine } = await import('../../flow/requirements.ts');
  const ctx = flowCtx(ports, 'project' as import('../../common/ids.ts').MissionId);
  const line = constraintLine(req.constraint);
  const ix = await basisIndex(ctx);
  const current = ix.current.get(line);
  const rec = current === undefined ? undefined : ix.records.get(current);
  if (rec === undefined || (rec.basisKind !== 'constraint' && rec.basisKind !== 'instruction')) throw new Error(`No constraint ${req.constraint}: nothing was withdrawn.`);
  if (ix.withdrawn.has(line)) return;
  const owner = flowCtx(ports, rec.mission ?? ctx.mission);
  await commit(owner, `flow:constraint-withdraw:${line}`, { events: [ev(owner, 'requirements', 'constraint-withdrawn', line, { line, version: current, words: req.words })], records: [{ kind: 'basis.withdrawn', line: rec.line }] });
}
