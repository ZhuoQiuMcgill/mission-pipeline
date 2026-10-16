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
