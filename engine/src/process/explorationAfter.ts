// An exploration planned after others (design 3.10, 4.3; flow/exploration/predecessors.ts): its
// first step waits until every exploration its PM plan element names in "after" has settled (its
// current settle: one a rerun reopened is none). `mp pm next` lists the step as held with the
// explorations it waits for, and `mp pm dispatch` refuses it; once they settled the step is ready,
// and its claim puts what they handed on on its card (seat/cards/refresh.ts). An exploration with a
// step dispatched already is never held by this: one a later plan places after others goes on, and
// its next cards carry their materials.

import type { MissionId } from '../common/ids.ts';
import { xid } from '../flow/exploration/definition.ts';
import { effectivePlans, foldExploration, plannedAfter } from '../flow/exploration/predecessors.ts';
import { PLAN_LINE, PM_PLAN_EFFECTIVE, explorationLine } from '../flow/plandoc.ts';
import type { DataStore } from '../memory/data.ts';
import { flowEvents, listDispatches, type Db, type FlowEventRow } from '../memory/index.ts';
import type { TaskSpecDoc } from './ports.ts';

/** The seats of an exploration's steps (no other flow uses them). */
const SEATS: ReadonlySet<string> = new Set(['researcher-author', 'researcher-reader', 'researcher-interpreter', 'constructor-experiment', 'crititor', 'stabilizer']);

function rows(db: Db, q: { readonly mission: MissionId; readonly line?: string; readonly event?: string }): FlowEventRow[] {
  const out: FlowEventRow[] = [];
  for (let after = 0; ; ) {
    const page = flowEvents(db, { ...q, after, limit: 1000 });
    if (page.length === 0) return out;
    out.push(...page);
    after = Number(page.at(-1)!.revision);
  }
}

function read(db: Db, data: DataStore, q: { readonly mission: MissionId; readonly line: string; readonly event?: string }) {
  return rows(db, q).map((e) => ({ line: e.line, event: e.event, key: e.key, body: JSON.parse(data.text(e.body)) as unknown }));
}

/** The exploration a step belongs to: its lineage is the exploration's, or one of its evidence executions' (definition.ts xid). */
function explorationOfStep(db: Db, mission: MissionId, lineage: string): string | null {
  for (const e of rows(db, { mission, event: 'defined' })) {
    if (!e.line.startsWith('exploration:')) continue;
    const x = e.line.slice('exploration:'.length);
    const own = xid.lineage(mission, x);
    if (lineage === own || lineage.startsWith(`${own}.ev`)) return x;
  }
  return null;
}

/**
 * Why an exploration's step waits for the explorations planned before it, or null (it does not:
 * another flow's step, an exploration planned after none, or one with a step dispatched already).
 */
export function heldByPredecessors(db: Db, data: DataStore, spec: TaskSpecDoc): string | null {
  if (!SEATS.has(spec.card.seat)) return null;
  const mission = spec.mission as MissionId;
  const x = explorationOfStep(db, mission, spec.lineage);
  if (x === null) return null;
  const s = foldExploration(read(db, data, { mission, line: explorationLine(x) }));
  // a step of it was dispatched already (a released one too): it goes on
  if ([...s.tasks.keys()].some((t) => listDispatches(db, { task: t, limit: 1 }).length > 0)) return null;
  const after = plannedAfter(effectivePlans(read(db, data, { mission, line: PLAN_LINE, event: PM_PLAN_EFFECTIVE }), (h) => data.text(h)), x);
  if (after === null) return null;
  const waiting: string[] = [];
  for (const p of after.explorations) {
    const ps = foldExploration(read(db, data, { mission, line: explorationLine(p) }));
    if (ps.settled === null) waiting.push(`${p} (${ps.defined === null ? 'not defined yet' : ps.settles.length > 0 ? 'reopened' : 'not settled'})`);
  }
  if (waiting.length === 0) return null;
  return `exploration ${x} waits for ${waiting.join(', ')} to settle: element ${after.element} of PM plan ${after.plan} places it after ${after.explorations.join(', ')}; it starts once they have, and its card then carries what they handed on`;
}
