// The explorations planned before an exploration (design 3.10, 4.3): its PM plan element's "after"
// names them (an element that is an exploration, or the exploration's own id). What each of them
// handed on is a material of the cards of the seats that know the exploration (the author, the
// interpreter, the Crititor and the Stabilizer): the hand-off of its current settle and its latest
// version, with the version it settled on when that is an earlier one. The author must read them,
// the others may; a blind executor gets none (4.3). The list is read from the plan in effect, never
// from the exploration's definition (its canonical form is hashed into the definition's basis
// versions): the cards are built with it (cards.ts) and the claim selects it again
// (seat/cards/refresh.ts), so a card queued before a predecessor settled reads its hand-off. The
// exploration's first step waits until every one of them has settled (process/explorationAfter.ts).

import { canonicalJson } from '../../common/hash.ts';
import type { MissionId } from '../../common/ids.ts';
import { materialPageCount, type MaterialRef } from '../../seat/cards/common.ts';
import { PLAN_LINE, PM_PLAN_EFFECTIVE, PmPlanDoc, explorationLine, type PmPlanEffectiveBody } from '../plandoc.ts';
import type { FlowLedgerPort } from '../ports.ts';
import { fold, type XEvent, type XState } from './machine.ts';

/** An exploration planned before this one, folded as the ledger holds it now. */
export interface Predecessor {
  readonly exploration: string;
  readonly state: XState;
}

/** The plan element that places an exploration after others: the plan, the element, and the explorations it names. */
export interface PlannedAfter {
  readonly plan: string;
  readonly element: string;
  readonly explorations: readonly string[];
}

type PlanEvent = { readonly line: string; readonly event: string; readonly body: unknown };

/** The effective PM plans in ledger order, each with its document. */
export function effectivePlans(events: Iterable<PlanEvent>, text: (hash: string) => string): Array<{ readonly body: PmPlanEffectiveBody; readonly doc: PmPlanDoc }> {
  const out: Array<{ readonly body: PmPlanEffectiveBody; readonly doc: PmPlanDoc }> = [];
  for (const e of events) {
    if (e.line !== PLAN_LINE || e.event !== PM_PLAN_EFFECTIVE) continue;
    const body = e.body as PmPlanEffectiveBody;
    out.push({ body, doc: PmPlanDoc.parse(JSON.parse(text(body.doc))) });
  }
  return out;
}

/**
 * The explorations exploration `x` is planned after: the "after" of its element in the last
 * effective PM plan that defines it (the plan its definition is read from, step.ts). An entry names
 * an element of that plan that is an exploration, or an exploration of it by its id; other entries
 * (a deliverable...) are not explorations and are left out. Null when no plan defines it.
 */
export function plannedAfter(plans: ReadonlyArray<{ readonly body: PmPlanEffectiveBody; readonly doc: PmPlanDoc }>, x: string): PlannedAfter | null {
  let out: PlannedAfter | null = null;
  for (const { body, doc } of plans) {
    const el = doc.elements.find((e) => e.exploration?.id === x);
    if (el === undefined || !body.explorations.includes(x)) continue;
    const explorations: string[] = [];
    for (const a of el.after) {
      const p = (doc.elements.find((e) => e.id === a && e.exploration !== undefined) ?? doc.elements.find((e) => e.exploration?.id === a))?.exploration?.id;
      if (p !== undefined && p !== x && !explorations.includes(p)) explorations.push(p);
    }
    out = { plan: body.plan, element: el.id, explorations };
  }
  return out;
}

/** An exploration's state from the events of its line. */
export function foldExploration(events: Iterable<{ readonly event: string; readonly key: string; readonly body: unknown }>): XState {
  const xs: XEvent[] = [];
  for (const e of events) xs.push({ event: e.event, key: e.key, body: e.body });
  return fold(xs);
}

/** The explorations `x` is planned after, from the flow's ledger (queue time). */
export async function predecessorsOf(ledger: Pick<FlowLedgerPort, 'events' | 'content'>, mission: MissionId, x: string): Promise<Predecessor[]> {
  const plans = effectivePlans(await ledger.events({ mission, line: PLAN_LINE, event: PM_PLAN_EFFECTIVE }), (h) => ledger.content.get(h));
  const out: Predecessor[] = [];
  for (const p of plannedAfter(plans, x)?.explorations ?? []) out.push({ exploration: p, state: foldExploration(await ledger.events({ mission, line: explorationLine(p) })) });
  return out;
}

/** The explorations `x` is planned after, from a mission's flow events (claim time: refresh.ts). */
export function predecessorsFrom(events: readonly { readonly line: string; readonly event: string; readonly key: string; readonly body: unknown }[], text: (hash: string) => string, x: string): Predecessor[] {
  const after = plannedAfter(effectivePlans(events, text), x)?.explorations ?? [];
  return after.map((p) => ({ exploration: p, state: foldExploration(events.filter((e) => e.line === explorationLine(p))) }));
}

const PREFIX = 'after-';

/** Whether a card's material is a predecessor's (no other material id starts so). */
export function predecessorMaterial(id: string): boolean {
  return id.startsWith(PREFIX);
}

/**
 * The materials of the explorations planned before this one, in plan order: for each, once it
 * settled, the hand-off (its settle as the decision layer reads it, and the hand-off of the stop it
 * settled on); its latest version, labelled with the version it settled on; and that version too
 * when it is an earlier one (readable, never must-read). `mustRead` (the author's card) makes the
 * hand-off and the latest version must-read.
 */
export function predecessorMaterials(preds: readonly Predecessor[], content: { get(hash: string): string; put(doc: string): string }, mustRead: boolean): MaterialRef[] {
  const out: MaterialRef[] = [];
  const add = (id: string, title: string, ref: string, must: boolean): void => {
    out.push({ id, title, ref, pages: materialPageCount(content.get(ref)), mustRead: must });
  };
  for (const { exploration: x, state: s } of preds) {
    const settled = s.settled;
    const on = settled?.body.artifact ?? null;
    const latest = s.versions.at(-1) ?? null;
    const earlier = on !== null && on !== latest?.id ? (s.versions.find((v) => v.id === on) ?? null) : null;
    if (settled !== null) {
      const handoff = s.stopped !== null ? (JSON.parse(content.get(s.stopped.handoff)) as unknown) : null;
      add(`${PREFIX}${x}-handoff`, `Exploration ${x}, planned before this one: its hand-off (settled: ${settled.body.outcome}, ${settled.body.stop}, on ${on ?? 'no version'})`, content.put(canonicalJson({ exploration: x, settled: settled.body, handoff })), mustRead);
    }
    if (latest !== null) {
      const which = settled === null ? 'it has not settled' : on === latest.id ? 'the version it settled on' : on === null ? 'it settled on no version' : `it settled on the earlier version ${on}`;
      add(`${PREFIX}${x}-latest`, `Exploration ${x}, planned before this one: its latest version ${latest.id} (${which})`, latest.content, mustRead);
    }
    if (earlier !== null) add(`${PREFIX}${x}-settled`, `Exploration ${x}, planned before this one: version ${earlier.id}, the one it settled on (not its latest)`, earlier.content, false);
  }
  return out;
}

/** A card's materials with the predecessors' as selected now: its own first, then theirs (the order the builders use). */
export function withPredecessorMaterials(materials: readonly MaterialRef[], preds: readonly MaterialRef[]): MaterialRef[] {
  return [...materials.filter((m) => !predecessorMaterial(m.id)), ...preds];
}
