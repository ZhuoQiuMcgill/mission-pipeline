// The program's mechanical checks of a detailed plan (design 3.5, 3.10). No model, no tokens.
//
//   1. Coverage within this round's executable scope: every PM plan element that is not an
//      exploration and does not wait for an unsettled exploration has a task; every element of
//      the detailed plan traces to a PM plan element or is marked "architect". Goals beyond an
//      unsettled exploration need no coverage, and no task may be planned for them (3.10).
//   2. Tasks that can run in parallel have non-overlapping write scopes; the integration task
//      depends on every module task and is not in this check.
//   3. Scheduling dependencies exist and have no cycle; every interface used is either found in
//      the snapshot (file and symbol) or defined by a task of the plan; an interface's
//      definition task comes before its users.
//   4. With more than one implementation task there is exactly one integration task, and it
//      depends on every implementation task (3.4).
//   5. Order changes against a user-specified PM plan order are reported separately: they go
//      straight to the Secretary (3.5), they do not send the plan back.
// Any failure of 1–4 sends the plan back to the Architect (the mechanical-return loop, 6.5).

import { planIdProblems, type DetailedPlanDoc, type DetailedTask, type PmPlanDoc } from './plandoc.ts';

export interface MechanicalResult {
  readonly ok: boolean;
  readonly failures: readonly string[];
  readonly orderChanges: readonly string[];
}

/** Can two write-scope patterns name a common path ("a/b.ts", "a/**", "**")? */
export function patternsOverlap(a: string, b: string): boolean {
  if (a === '**' || b === '**') return true;
  const dirA = a.endsWith('/**') ? a.slice(0, -3) : null;
  const dirB = b.endsWith('/**') ? b.slice(0, -3) : null;
  const under = (path: string, dir: string): boolean => path === dir || path.startsWith(`${dir}/`);
  if (dirA !== null && dirB !== null) return under(dirA, dirB) || under(dirB, dirA);
  if (dirA !== null) return under(b, dirA);
  if (dirB !== null) return under(a, dirB);
  return a === b;
}

export function scopesOverlap(a: readonly string[], b: readonly string[]): string[] {
  const out: string[] = [];
  for (const x of a) for (const y of b) if (patternsOverlap(x, y)) out.push(x === y ? x : `${x} ~ ${y}`);
  return out;
}

/** Transitive dependencies of each task (null when the graph has a cycle through it). */
function closure(tasks: readonly DetailedTask[]): { deps: Map<string, Set<string>>; cycle: string[] | null } {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const deps = new Map<string, Set<string>>();
  const state = new Map<string, 'visiting' | 'done'>();
  let cycle: string[] | null = null;
  const visit = (id: string, path: string[]): Set<string> => {
    const known = deps.get(id);
    if (known !== undefined) return known;
    if (state.get(id) === 'visiting') {
      if (cycle === null) cycle = [...path.slice(path.indexOf(id)), id];
      return new Set();
    }
    state.set(id, 'visiting');
    const out = new Set<string>();
    for (const d of byId.get(id)?.dependsOn ?? []) {
      if (!byId.has(d)) continue;
      out.add(d);
      for (const x of visit(d, [...path, id])) out.add(x);
    }
    state.set(id, 'done');
    deps.set(id, out);
    return out;
  };
  for (const t of tasks) visit(t.id, []);
  return { deps, cycle };
}

export interface MechanicalInputs {
  readonly pmPlan: PmPlanDoc;
  readonly plan: DetailedPlanDoc;
  /** Explorations that have not stood yet (3.10). */
  readonly unsettled: ReadonlySet<string>;
  /** Whether the snapshot has `symbol` in `file` (3.5 "在快照中找得到对应文件和符号"). */
  readonly hasSymbol: (file: string, symbol: string) => Promise<boolean>;
}

export async function mechanicalCheck(i: MechanicalInputs): Promise<MechanicalResult> {
  const { pmPlan, plan } = i;
  // ids that repeat make conflicting facts downstream (one judgment per standard, one evidence per command): bounced to the Architect
  const failures: string[] = planIdProblems(plan).map((p) => `ids: ${p}`);
  const orderChanges: string[] = [];
  const elements = new Map(pmPlan.elements.map((e) => [e.id, e]));
  const waiting = (id: string): boolean => (elements.get(id)?.after ?? []).some((x) => i.unsettled.has(x)) || (elements.get(id)?.kind === 'exploration' && i.unsettled.has(elements.get(id)?.exploration?.id ?? ''));

  // 1. coverage and provenance
  const covered = new Set(plan.tasks.flatMap((t) => (t.provenance === 'architect' ? [] : [t.provenance.planElement])));
  for (const e of pmPlan.elements) {
    if (e.kind === 'exploration' || waiting(e.id)) continue;
    if (!covered.has(e.id)) failures.push(`coverage: PM plan element "${e.id}" has no task`);
  }
  const provenances: Array<[string, DetailedTask['provenance']]> = [
    ...plan.tasks.map((t) => [`task ${t.id}`, t.provenance] as [string, DetailedTask['provenance']]),
    ...plan.newInterfaces.map((x) => [`new interface ${x.name}`, x.provenance] as [string, DetailedTask['provenance']]),
    ...plan.reusedInterfaces.map((x) => [`reused interface ${x.name}`, x.provenance] as [string, DetailedTask['provenance']]),
    ...plan.modules.map((m) => [`module ${m.id}`, m.provenance] as [string, DetailedTask['provenance']]),
  ];
  for (const [what, p] of provenances) {
    if (p === 'architect') continue;
    const e = elements.get(p.planElement);
    if (e === undefined) failures.push(`provenance: ${what} traces to "${p.planElement}", which is not a PM plan element`);
    else if (e.kind === 'exploration') failures.push(`provenance: ${what} traces to exploration element "${e.id}"; explorations are not decomposed into tasks`);
    else if (waiting(e.id)) failures.push(`round: ${what} plans element "${e.id}", which waits for an exploration that has not stood (3.10)`);
  }

  // 3. dependencies: known, acyclic
  const ids = new Set(plan.tasks.map((t) => t.id));
  for (const t of plan.tasks) for (const d of t.dependsOn) if (!ids.has(d)) failures.push(`dependencies: task ${t.id} depends on unknown task "${d}"`);
  const { deps, cycle } = closure(plan.tasks);
  if (cycle !== null) failures.push(`dependencies: the scheduling dependencies have a cycle: ${(cycle as string[]).join(' → ')}`);
  const dependsOn = (a: string, b: string): boolean => deps.get(a)?.has(b) ?? false;

  // 2. parallel write scopes (integration tasks excluded)
  const parallelCandidates = plan.tasks.filter((t) => t.kind !== 'integration');
  for (let x = 0; x < parallelCandidates.length; x++) {
    for (let y = x + 1; y < parallelCandidates.length; y++) {
      const a = parallelCandidates[x] as DetailedTask;
      const b = parallelCandidates[y] as DetailedTask;
      if (dependsOn(a.id, b.id) || dependsOn(b.id, a.id)) continue;
      const overlap = scopesOverlap(a.writeScope, b.writeScope);
      if (overlap.length > 0) failures.push(`write scopes: tasks ${a.id} and ${b.id} can run in parallel and both write ${overlap.join(', ')}`);
    }
  }

  // 4. integration
  const impl = plan.tasks.filter((t) => t.kind === 'implementation');
  const integ = plan.tasks.filter((t) => t.kind === 'integration');
  if (impl.length > 1) {
    if (integ.length !== 1) failures.push(`integration: ${impl.length} implementation tasks need exactly one integration task (found ${integ.length})`);
    for (const g of integ) for (const m of impl) if (!dependsOn(g.id, m.id)) failures.push(`integration: integration task ${g.id} does not depend on module task ${m.id}`);
  }

  // 3. interfaces: found in the snapshot or defined by a task, definitions before users
  const defined = new Map<string, string[]>();
  for (const t of plan.tasks) if (t.kind === 'interface') for (const n of t.implements) defined.set(n, [...(defined.get(n) ?? []), t.id]);
  const declaredNew = new Set(plan.newInterfaces.map((x) => x.name));
  for (const n of declaredNew) if (!defined.has(n) && !plan.tasks.some((t) => t.implements.includes(n))) failures.push(`interfaces: new interface ${n} is defined by no task`);
  const reused = new Map(plan.reusedInterfaces.map((x) => [x.name, x]));
  for (const [name, r] of reused) if (!(await i.hasSymbol(r.file, name))) failures.push(`interfaces: reused interface ${name} is not found in ${r.file} of the snapshot`);
  for (const t of plan.tasks) {
    for (const n of [...t.calls, ...(t.kind === 'interface' ? [] : t.implements)]) {
      if (reused.has(n)) continue;
      const defs = defined.get(n);
      if (defs === undefined) {
        if (!declaredNew.has(n)) failures.push(`interfaces: task ${t.id} uses ${n}, which is neither found in the snapshot nor defined by a task`);
        continue;
      }
      for (const d of defs) if (d !== t.id && !dependsOn(t.id, d)) failures.push(`interfaces: task ${t.id} uses ${n} but does not come after its definition task ${d}`);
    }
  }

  // 5. order against a user-specified PM plan order
  if (pmPlan.order === 'user') {
    const pos = new Map(pmPlan.elements.map((e, k) => [e.id, k]));
    const elementOf = (t: DetailedTask): string | null => (t.provenance === 'architect' ? null : t.provenance.planElement);
    for (const t of plan.tasks) {
      const et = elementOf(t);
      if (et === null) continue;
      for (const d of deps.get(t.id) ?? []) {
        const dt = plan.tasks.find((x) => x.id === d);
        const ed = dt === undefined ? null : elementOf(dt);
        if (ed === null || ed === et) continue;
        if ((pos.get(ed) ?? 0) > (pos.get(et) ?? 0)) orderChanges.push(`task ${t.id} (element ${et}) waits for task ${d} (element ${ed}), which the user put later`);
      }
    }
  }

  return { ok: failures.length === 0, failures: [...new Set(failures)], orderChanges: [...new Set(orderChanges)] };
}
