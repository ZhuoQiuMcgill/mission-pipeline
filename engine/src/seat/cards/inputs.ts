// Queue-time builders and claim-time refresh share the complete derivation of proof inputs.
import { idPart } from '../../common/ids.ts';
import { safeId } from '../../flow/context.ts';
import { decodeConstraintCheck, encodeConstraintCheck, type ObjectVersionRecord, type ReviewContract, type ObjectScope } from '../../common/records.ts';
import { requiredRange } from '../../evaluator/semantics.ts';
import { constraintApplies } from '../../memory/domain/constraints.ts';
import type { BasisIndex } from '../../flow/context.ts';
import { DetailedPlanDoc, amendedPlan, type AmendmentEntry, type DetailedTask } from '../../flow/plandoc.ts';
import type { ConstraintBody, CurrentItem } from '../../flow/requirements.ts';
import { canonicalJson } from '../../common/hash.ts';

export const standardLine = (mission: string, task: string, standard: string) => safeId(`std.${mission}.${idPart(task)}.${idPart(standard)}`);

export function contractLines(mission: string, t: DetailedTask, ix: BasisIndex, fixed?: ReviewContract): string[] {
  if (fixed !== undefined) return [...fixed.basisLines];
  return [...t.standards.map((s) => standardLine(mission, t.id, s.id)), ...t.requirementItems.filter((l) => ix.current.has(l) && !ix.withdrawn.has(l))];
}

export function objectConstraints(constraints: readonly ConstraintBody[], obj: { scope: ObjectScope; mission: string }) {
  const applying = constraints.filter((c) => c.kind === 'object' && constraintApplies(c, obj))
    .map((c) => ({ c, paths: [...new Set(requiredRange(c.scope, obj.scope))].sort() }));
  return {
    applicable: applying.map(({ c, paths }) => ({ line: c.line, version: c.version, paths })).sort(byLine),
    checks: [...new Set(applying.map(({ c, paths }) => encodeConstraintCheck({ version: c.version, paths })))].sort(),
    list: applying.map(({ c, paths }) => ({ id: c.line, text: `${c.text} (applies to: ${paths.join(', ')})`, kind: 'object' as const })),
  };
}

const byLine = (a: { line: string }, b: { line: string }) => a.line < b.line ? -1 : a.line > b.line ? 1 : 0;

export function boundObjectConstraints(ix: BasisIndex, checks: readonly string[]) {
  return checks.map((check) => {
    const { version, paths } = decodeConstraintCheck(check);
    const line = ix.lineOf.get(version);
    if (line === undefined) throw new Error(`Unknown constraint version ${version}`);
    return { line, version, paths: [...new Set(paths)].sort() };
  }).sort(byLine);
}

export interface PlanningInputs {
  task: string;
  target?: string;
  bases: string[];
  constraints?: ReturnType<typeof objectConstraints>['applicable'];
  context?: string[];
}

export function planningContext(items: readonly CurrentItem[]): string[] {
  return items.map((i) => canonicalJson([i.line, i.version, i.state])).sort();
}

/** Compare the whole applicable set, including additions, removals and changed ranges. */
export function changedPlanningInputs(inputs: PlanningInputs, ix: BasisIndex, items: readonly CurrentItem[], constraints: readonly ConstraintBody[], obj?: ObjectVersionRecord): string[] {
  const changed = changedBoundLines(ix, inputs.bases);
  if (inputs.context === undefined || canonicalJson(inputs.context) !== canonicalJson(planningContext(items))) changed.push('planning context');
  const applicable = obj === undefined ? [] : objectConstraints(constraints, obj).applicable;
  if (inputs.constraints === undefined || canonicalJson(inputs.constraints) !== canonicalJson(applicable)) changed.push('applicable object constraints');
  return changed;
}

export function auditNodeConstraints(positions: readonly import('./auditor.ts').AuditPositionT[]) {
  return [...new Map(positions.flatMap((p) => p.constraints.map((c) => [c.id, { id: c.id, text: c.text, kind: 'object' as const }] as const))).values()];
}

export function auditChainInputs(items: readonly CurrentItem[], ix: BasisIndex, constraints: readonly ConstraintBody[], obj: ObjectVersionRecord, request: string) {
  const words = items.filter((i) => i.source.kind === 'words');
  const quotes = (words.length > 0 ? words : items).map((i) => ({ id: i.line, text: i.source.kind === 'words' ? `"${i.source.quote}" (${i.type}: ${i.text})` : `${i.type}: ${i.text}` }));
  if (quotes.length === 0) quotes.push({ id: 'request', text: `(no requirement item is recorded) the user's request: "${request}"` });
  const lines = obj.reviews.find((r) => r.review === 'auditor-chain')?.basisLines ?? [];
  return { quotes, bases: lines.flatMap((l) => { const v = ix.current.get(l); return v !== undefined && !ix.withdrawn.has(l) ? [v] : []; }), ...objectConstraints(constraints, obj) };
}

export function withdrawnPlanReason(plan: ObjectVersionRecord, ix: BasisIndex): string | null {
  const line = plan.reviews.find((r) => r.review === 'calibrator-1')?.basisLines.find((l) => ix.withdrawn.has(l));
  return line === undefined ? null : `plan ${plan.object} relies on withdrawn ${line}; record a new plan version`;
}

/** Base text and versions, and constraint text/paths and checks, are regenerated together. */
export function auditPositionInputs(contract: ReviewContract, objects: readonly ObjectVersionRecord[], ix: BasisIndex, texts: ReadonlyMap<string, string>, constraints: readonly ConstraintBody[]): { missingBasis: string } | { bases: Array<{ id: string; text: string }>; constraints: Array<{ id: string; version: string; text: string; paths: string[] }>; versions: string[]; checks: string[] } {
  const bases: Array<{ id: string; text: string }> = [];
  const versions: string[] = [];
  for (const line of contract.basisLines) {
    const v = ix.current.get(line);
    if (v === undefined || ix.withdrawn.has(line)) return { missingBasis: line };
    const text = texts.get(line);
    if (text === undefined) return { missingBasis: line };
    versions.push(v);
    bases.push({ id: line, text: `${text} (version ${v})` });
  }
  if (bases.length === 0) bases.push({ id: 'contract', text: `the contract of position "${contract.review}" names no basis item: judge the node against its stated purpose and the objects it relies on` });
  const applying = constraints.filter((c) => c.kind === 'object').flatMap((c) => {
    const paths = [...new Set(objects.filter((o) => constraintApplies(c, o)).flatMap((o) => requiredRange(c.scope, o.scope)))].sort();
    return paths.length === 0 ? [] : [{ id: c.line, version: c.version, text: c.text, paths }];
  });
  return { bases, constraints: applying, versions: [...new Set(versions)].sort(), checks: applying.map((c) => encodeConstraintCheck({ version: c.version, paths: c.paths })).sort() };
}

/** Text resolver for every mission in an audit, including cross-mission unit members. */
export function auditBasisTexts(ix: BasisIndex, events: readonly import('../../flow/ports.ts').FlowEvent[], content: { get(hash: string): string; getList(hash: import('../../common/records.ts').ListRef): readonly string[] }, object: (id: string) => ObjectVersionRecord | undefined): Map<string, string> {
  const out = new Map<string, string>();
  const versions = new Map<string, import('../../flow/requirements.ts').ItemVersionBody>();
  const itemText = (i: import('../../flow/requirements.ts').ItemVersionBody) => `${i.type}: ${i.text}${i.source.kind === 'words' ? ` — the user's words: "${i.source.quote}"` : ''}`;
  for (const e of events) if (e.line === 'requirements' && e.event === 'item') {
    const i = e.body as import('../../flow/requirements.ts').ItemVersionBody;
    versions.set(i.version, i);
    if (ix.current.get(i.line) === i.version && !ix.withdrawn.has(i.line)) out.set(i.line, itemText(i));
  }
  for (const e of events) if (e.line === 'plan' && e.event === 'effective') {
    const obj = object((e.body as { dplan: string }).dplan);
    if (obj === undefined) continue;
    const d = JSON.parse(content.get(obj.content)) as import('../../flow/plandoc.ts').StoredDetailedPlan;
    // the plan's tasks and the tasks its repairs added, by the shared resolver (4.1.2, D-10)
    const plan = amendedPlan(DetailedPlanDoc.parse(d.plan), (e.body as { amendments?: readonly AmendmentEntry[] }).amendments);
    for (const t of plan.tasks) for (const st of t.standards) out.set(standardLine(e.mission, t.id, st.id), `acceptance standard ${st.id} of task ${t.id}: ${st.text}`);
  }
  for (const [line, v] of ix.current) {
    const rec = ix.records.get(v);
    if (rec?.basisKind !== 'requirement-set' || ix.withdrawn.has(line)) continue;
    const members = content.getList(rec.snapshot).map((iv) => versions.get(iv));
    if (members.every((i) => i !== undefined)) out.set(line, `the mission's requirement set (${members.length} item(s) in force): ${members.map((i) => `[${i!.line}] ${itemText(i!)}`).join('; ')}`);
  }
  for (const e of events) if (e.line.startsWith('exploration:') && (e.event === 'defined' || e.event === 'redefined')) {
    const b = e.body as { basisLine?: string; definition: { goal: string; exploration: string } };
    const line = b.basisLine ?? (events.find((d) => d.mission === e.mission && d.line === e.line && d.event === 'defined')?.body as { basisLine?: string } | undefined)?.basisLine;
    if (line !== undefined) out.set(line, `the definition of exploration ${b.definition.exploration}; the user's acceptance goal, verbatim: "${b.definition.goal}"`);
  }
  return out;
}

/** A claim cannot update only a part of the builder's derived inputs. */
export function changedBoundLines(ix: BasisIndex, versions: readonly string[]): string[] {
  return versions.flatMap((version) => {
    const line = ix.lineOf.get(version);
    return line !== undefined && (ix.withdrawn.has(line) || ix.current.get(line) !== version) ? [line] : [];
  });
}

export function reviewInputVersions(bases: readonly string[], checks: readonly string[]): string[] {
  return [...bases, ...checks.map((c) => decodeConstraintCheck(c).version)];
}
