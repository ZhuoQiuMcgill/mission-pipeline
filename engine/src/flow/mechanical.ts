// The program's mechanical checks of a detailed plan (design 3.5, 3.10; 4.1.2). No model, no tokens.
// MECHANICAL_RULES below is the list the Architect's card shows ("Mechanical checks your plan must
// pass"): the same list, never written twice.
//
//   1. Coverage within this round's executable scope: every PM plan element that is not an
//      exploration and does not wait for an unsettled exploration has a task (a task may cover
//      several elements); every element of the detailed plan traces to PM plan elements or is
//      marked "architect". Goals beyond an unsettled exploration need no coverage, and no task may
//      be planned for them (3.10).
//   2. Tasks that can run in parallel have non-overlapping write scopes; the integration task
//      depends on every module task and is not in this check.
//   3. Scheduling dependencies exist and have no cycle; every interface used is either found in
//      the snapshot (file and symbol) or defined by a task of the plan; an interface's
//      definition task comes before its users.
//   4. With more than one implementation task there is exactly one integration task, and it
//      depends on every implementation task (3.4).
//   5. Order changes against a user-specified PM plan order are reported separately: they go
//      straight to the Secretary (3.5), they do not send the plan back.
//   6. Every task writes something, except an integration task (it then gets no Constructor) or an
//      experiment (4.1.2: checks belong in the acceptance standards of the task they check).
//   7. Only the integration task runs the full suite: no other task declares one of its commands
//      as a verification command (D-5, D-6).
// Any failure of 1–4, 6, 7 sends the plan back to the Architect (the mechanical-return loop, 6.5).
// A repair's amendment (D-10) is checked as the plan in effect plus the added tasks: the per-task
// rules apply to the added tasks (the plan in effect passed them when it took effect), and rule 4
// leaves the added tasks out (the PM's full run at the end checks them, D-7).

import { elementsOf, planIdProblems, type DetailedPlanDoc, type DetailedTask, type PmPlanDoc } from './plandoc.ts';
import { isFullSuiteCommand, type SuiteCommand } from '../common/fullSuite.ts';

/** The mechanical checks in words (the Architect's card renders this list; mechanicalCheck applies it). */
export const MECHANICAL_RULES: ReadonlyArray<{ readonly id: string; readonly text: string }> = [
  { id: 'ids', text: 'Ids are unique: tasks, modules and interfaces in the plan, and each task\'s standard ids and verification command ids.' },
  { id: 'coverage', text: 'Every PM plan element of this round (not an exploration, not waiting for an exploration that has not stood) is covered by at least one task. A task may cover several elements: one change that satisfies several elements is one task.' },
  { id: 'provenance', text: 'Every task, module and interface traces to PM plan elements of this round, or is marked "architect"; nothing traces to an exploration element or to an element that waits for an exploration.' },
  { id: 'write scopes', text: 'Tasks that can run in parallel (neither depends on the other) have write scopes that do not overlap; the integration task is exempt.' },
  { id: 'dependencies', text: 'Every task a task depends on exists, and the dependencies have no cycle.' },
  { id: 'interfaces', text: 'Every interface a task implements or calls is reused (found in the named file of the snapshot) or defined by an interface task, and the task comes after its definition task.' },
  { id: 'integration', text: 'With more than one implementation task there is exactly one integration task, and it depends on every implementation task.' },
  { id: 'writes', text: 'Every task writes something, except an integration task (with nothing to write it gets no Constructor: its Reviewer judges its dependencies\' work laid together) or an experiment. A read-only "check" task is refused: checks belong in the acceptance standards of the task whose change they check.' },
  { id: 'full suite', text: 'Only the integration task runs the project\'s full suite (its Reviewer runs it last): no other task lists a full-suite command as a verification command. Give ordinary tasks the project\'s local commands.' },
  { id: 'order', text: 'A change to an element order the user specified is not a failure: it goes to the Secretary.' },
];

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
  /** The project's full suite (config `fullSuite`, COMMON's alias): only the integration task may run one of its commands. */
  readonly fullSuite?: readonly SuiteCommand[];
  /** A repair's amendment (D-10): the ids of the tasks it adds to the plan in effect (`plan` holds both). */
  readonly amendment?: { readonly added: ReadonlySet<string> };
  /**
   * Tasks earlier repairs added (plandoc.ts amendedTaskIds): the integration rule (rule 4) is
   * evaluated on the plan's own tasks only, so these, and the amendment's own added tasks, are
   * outside it in every later check (a later repair, a revision that carries them).
   */
  readonly amended?: ReadonlySet<string>;
}

/** Rule 6: a task that writes nothing, other than an integration task or an experiment. */
export function writesNothingProblem(t: Pick<DetailedTask, 'id' | 'kind' | 'writeScope'>): string | null {
  if (t.writeScope.length > 0 || t.kind === 'integration' || t.kind === 'experiment') return null;
  return `task ${t.id} writes nothing: checks belong in the acceptance standards of the task whose change they check; the full suite runs in the integration task's review.`;
}

/** Rule 7: a non-integration task that declares a full-suite command. */
export function fullSuiteProblem(t: Pick<DetailedTask, 'id' | 'kind' | 'verificationCommands'>, suite: readonly SuiteCommand[]): string | null {
  if (t.kind === 'integration' || suite.length === 0) return null;
  if (!t.verificationCommands.some((c) => isFullSuiteCommand(suite, c.command))) return null;
  return `task ${t.id} runs the full suite: only the integration task's Reviewer runs it (D-5, D-6).`;
}

export async function mechanicalCheck(i: MechanicalInputs): Promise<MechanicalResult> {
  const { pmPlan, plan } = i;
  // ids that repeat make conflicting facts downstream (one judgment per standard, one evidence per command): bounced to the Architect
  const failures: string[] = planIdProblems(plan).map((p) => `ids: ${p}`);
  const orderChanges: string[] = [];
  const elements = new Map(pmPlan.elements.map((e) => [e.id, e]));
  const waiting = (id: string): boolean => (elements.get(id)?.after ?? []).some((x) => i.unsettled.has(x)) || (elements.get(id)?.kind === 'exploration' && i.unsettled.has(elements.get(id)?.exploration?.id ?? ''));

  // a repair's amendment: the per-task rules apply to the tasks it adds (the plan in effect passed them)
  const checked = (t: DetailedTask): boolean => i.amendment === undefined || i.amendment.added.has(t.id);

  // 6, 7. every task writes something (integration and experiments excepted); the full suite only in the integration task
  for (const t of plan.tasks) {
    if (!checked(t)) continue;
    const ro = writesNothingProblem(t);
    if (ro !== null) failures.push(`writes: ${ro}`);
    const fs = fullSuiteProblem(t, i.fullSuite ?? []);
    if (fs !== null) failures.push(`full suite: ${fs}`);
  }

  // 1. coverage and provenance (a task may cover several elements: each counts)
  const covered = new Set(plan.tasks.flatMap((t) => elementsOf(t.provenance)));
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
    for (const id of elementsOf(p)) {
      const e = elements.get(id);
      if (e === undefined) failures.push(`provenance: ${what} traces to "${id}", which is not a PM plan element`);
      else if (e.kind === 'exploration') failures.push(`provenance: ${what} traces to exploration element "${e.id}"; explorations are not decomposed into tasks`);
      else if (waiting(e.id)) failures.push(`round: ${what} plans element "${e.id}", which waits for an exploration that has not stood (3.10)`);
    }
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
      if (!checked(a) && !checked(b)) continue;
      const overlap = scopesOverlap(a.writeScope, b.writeScope);
      if (overlap.length > 0) failures.push(`write scopes: tasks ${a.id} and ${b.id} can run in parallel and both write ${overlap.join(', ')}`);
    }
  }

  // 4. integration
  // rule 4 is evaluated on the plan's own tasks: implementation tasks any repair added (earlier ones, or this
  // amendment's) are outside it in every check; the PM's full run at the end checks them (D-7)
  const outside = (t: DetailedTask): boolean => (i.amendment?.added.has(t.id) ?? false) || (i.amended?.has(t.id) ?? false);
  const impl = plan.tasks.filter((t) => t.kind === 'implementation' && !outside(t));
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
    if (!checked(t)) continue;
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

  // 5. order against a user-specified PM plan order: every element a task covers counts (the
  // task's work for an element waits for the dependency's work for an element the user put later)
  if (pmPlan.order === 'user') {
    const pos = new Map(pmPlan.elements.map((e, k) => [e.id, k]));
    for (const t of plan.tasks) {
      if (!checked(t)) continue;
      const ets = elementsOf(t.provenance);
      for (const d of deps.get(t.id) ?? []) {
        const dt = plan.tasks.find((x) => x.id === d);
        const eds = dt === undefined ? [] : elementsOf(dt.provenance);
        for (const et of ets) {
          for (const ed of eds) {
            if (ets.includes(ed)) continue;
            if ((pos.get(ed) ?? 0) > (pos.get(et) ?? 0)) orderChanges.push(`task ${t.id} (element ${et}) waits for task ${d} (element ${ed}), which the user put later`);
          }
        }
      }
    }
  }

  return { ok: failures.length === 0, failures: [...new Set(failures)], orderChanges: [...new Set(orderChanges)] };
}
