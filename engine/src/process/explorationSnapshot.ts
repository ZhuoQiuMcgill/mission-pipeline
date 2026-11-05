// An exploration's snapshot taken again (design 4.3, 7.2). The commit an exploration's seats read is
// fixed when it is defined (flow/exploration/flow.ts defineExploration), so code that lands on the
// target branch afterwards, such as a tool the same mission builds for its explorations, would stay
// out of their reach. Two routes take it again from the target branch, each in one write with its
// checks (flow.ts resnapshotEntries):
//   - the dispatch of its first step (pmDispatch's claim): while no step of the exploration was
//     ever dispatched and it is not settled, when the branch moved. Nothing ran on the old snapshot,
//     so nothing is invalidated;
//   - the PM's word, `mp pm resnapshot-exploration` (a started exploration). Refused while it is
//     settled, while the branch is at its snapshot, and while a dispatch of it is in flight or its
//     hand-back is not taken into account yet. Nothing runs again by itself; evidence recorded before
//     still counts, and every read of the exploration labels it "older environment".
// Every dispatch of an exploration's step hands its card over with the snapshot in force
// (cards.ts cardAtClaim): a card queued before a resnapshot reads the new one.
// 4.1.3 (E-5): the PM's route is a change form of the one repair entry, `mp pm repair --about <x>
// --resnapshot`: the repair and the snapshot are one write, and the snapshot answers the repair. The
// older command keeps its name for one release and records a repair the same way. Its refusals are
// NOT_ALLOWED with the reason, but a run a seat holds (DISPATCH_IN_FLIGHT).

import { canonicalJson } from '../common/hash.ts';
import type { ContentHash, MissionId } from '../common/ids.ts';
import type { BaseRecord } from '../common/records.ts';
import { cardAtClaim, stabilizerCardAtHandBack } from '../flow/exploration/cards.ts';
import type { StabilizerCard } from '../seat/cards/stabilizer.ts';
import { xid } from '../flow/exploration/definition.ts';
import { resnapshotEntries } from '../flow/exploration/flow.ts';
import { fold, olderSnapshotEvidence, pendingTasks, type XEvent, type XState } from '../flow/exploration/machine.ts';
import { explorationLine } from '../flow/plandoc.ts';
import type { FlowEventInput } from '../flow/ports.ts';
import type { DataStore } from '../memory/data.ts';
import { appendRecords, flowEvents, listDispatches, type Db, type FlowEventRow, type WriteTx } from '../memory/index.ts';
import { REPAIRS_LINE } from '../flow/plandoc.ts';
import { changeFormRepair } from '../flow/repair.ts';
import type { ChangeRepair } from './explorationAttempts.ts';
import { advance } from './advance.ts';
import type { ProcessContext } from './context.ts';
import { ProcessError } from './errors.ts';
import { taskStatus, type TaskSpecDoc } from './ports.ts';

/** The seats of an exploration's steps (no other flow uses them). */
const SEATS: ReadonlySet<string> = new Set(['researcher-author', 'researcher-reader', 'researcher-interpreter', 'constructor-experiment', 'crititor', 'stabilizer']);

/** Whether a card is an exploration step's. */
export function explorationSeat(seat: string): boolean {
  return SEATS.has(seat);
}

function rows(db: Db, q: { readonly mission: MissionId; readonly line?: string; readonly event?: string }): FlowEventRow[] {
  const out: FlowEventRow[] = [];
  for (let after = 0; ; ) {
    const page = flowEvents(db, { ...q, after, limit: 1000 });
    if (page.length === 0) return out;
    out.push(...page);
    after = Number(page.at(-1)!.revision);
  }
}

/** The exploration a step belongs to: its lineage is the exploration's, or one of its evidence executions' (definition.ts xid). */
function explorationOf(db: Db, mission: MissionId, lineage: string): string | null {
  for (const e of rows(db, { mission, event: 'defined' })) {
    if (!e.line.startsWith('exploration:')) continue;
    const x = e.line.slice('exploration:'.length);
    const own = xid.lineage(mission, x);
    if (lineage === own || lineage.startsWith(`${own}.ev`)) return x;
  }
  return null;
}

/** The exploration's events as the machine folds them, read in this transaction. */
function eventsOf(db: Db, data: DataStore, mission: MissionId, x: string): XEvent[] {
  return rows(db, { mission, line: explorationLine(x) }).map((e) => ({ event: e.event, key: e.key, body: JSON.parse(data.text(e.body)) as unknown }));
}

/** The resnapshot's event and its env.snapshot record, in this write. */
function record(tx: WriteTx, e: { readonly event: FlowEventInput; readonly record: BaseRecord }): void {
  appendRecords(tx, [{ kind: 'flow.event', mission: e.event.mission, line: e.event.line, event: e.event.event, key: e.event.key, body: tx.data.put(canonicalJson(e.event.body)) as ContentHash }, e.record]);
}

/**
 * The spec of an exploration's step as its dispatch claims it (pmDispatch, in the claim's own write;
 * any other step's spec is returned as it is). Before the exploration's first step runs, its snapshot
 * is taken again when the target branch moved since (`head`: the branch's head, read before the
 * write; null: not read): recorded in this write. Then the card names the snapshot in force.
 */
export function claimExplorationStep(tx: WriteTx, spec: TaskSpecDoc, head: string | null): TaskSpecDoc {
  if (!explorationSeat(spec.card.seat)) return spec;
  const mission = spec.mission;
  const x = explorationOf(tx, mission, spec.lineage);
  if (x === null) return spec;
  const events = eventsOf(tx, tx.data, mission, x);
  let s = fold(events);
  if (s.defined === null) return spec;
  // nothing ran on the old snapshot yet: no step of it was ever claimed (a released one was)
  const untouched = s.settled === null && [...s.tasks.keys()].every((t) => listDispatches(tx, { task: t, limit: 1 }).length === 0);
  if (head !== null && untouched) {
    const e = resnapshotEntries(s, { path: head, commit: head }, (d) => tx.data.put(d), { by: 'dispatch', step: spec.task });
    if (e !== null) {
      record(tx, e);
      s = fold([...events, { event: e.event.event, key: e.event.key, body: e.body }]);
    }
  }
  const card = cardAtClaim(s, spec.card);
  return card === spec.card ? spec : { ...spec, card };
}

/**
 * #25 (E-3): the card an exploration step's hand-back is recorded against (seat.ts, before its write):
 * a Stabilizer's judges the direction questions as the record holds them at the hand-back, so a ruling
 * recorded while it ran counts (cards.ts stabilizerCardAtHandBack). Any other card is returned as it is.
 */
export function explorationCardAtHandBack<C extends { readonly seat: string }>(db: Db, data: DataStore, mission: MissionId, lineage: string, card: C): C {
  if (card.seat !== 'stabilizer') return card;
  const x = explorationOf(db, mission, lineage);
  if (x === null) return card;
  return stabilizerCardAtHandBack(fold(eventsOf(db, data, mission, x)), card as unknown as StabilizerCard) as unknown as C;
}

/** What `mp pm resnapshot-exploration` did. */
export interface Resnapshotted {
  /** The commit the seats read from now on, and the one it replaces. */
  readonly snapshot: string;
  readonly previous: string;
  /** Its number on the exploration (1 for the first). */
  readonly n: number;
  /** The evidence recorded before: it still counts, and every read labels it "older environment". */
  readonly olderEvidence: readonly string[];
  /** 4.1.3: the repair it recorded and answers, or null. */
  readonly repair: string | null;
}

/** The refusals of `mp pm resnapshot-exploration` that the exploration's state decides (nothing is written). */
function refuse(db: Db, data: DataStore, mission: string, x: string, s: XState): void {
  if (s.settled !== null) {
    throw new ProcessError(
      'NOT_ALLOWED',
      `exploration ${x} of ${mission} is settled (${s.settled.body.outcome}): its result was handed on, on the snapshot it settled on. After an environment change, mp pm reopen-exploration ${mission} ${x} re-checks it; to explore again on the code as it is now, give the exploration a new id in the PM plan`,
    );
  }
  for (const q of pendingTasks(s)) {
    const st = taskStatus(db, data, q.task);
    if (st?.state === 'running') {
      throw new ProcessError('DISPATCH_IN_FLIGHT', `${st.note ?? 'a dispatch is in flight'} for step ${q.task} of exploration ${x} (the ${q.role}): its seat reads the snapshot its card names and would see it change under it. Wait for its hand-back (or release it), then run this again`);
    }
    if (st?.state === 'done' || st?.state === 'waiting-evidence') {
      throw new ProcessError('DISPATCH_IN_FLIGHT', `step ${q.task} of exploration ${x} handed back and the exploration has not taken it into account yet: run mp pm next, then this again`);
    }
  }
}

/**
 * `mp pm resnapshot-exploration <mission> <exploration> --words W-<n>`: the PM's word that a started,
 * unsettled exploration reads the target branch as it is now (code that landed after it began). Its
 * cards from now on name the new snapshot; nothing runs again by itself, and evidence recorded before
 * still counts, labelled "older environment". Refused (named, nothing written): not defined
 * (NOT_ALLOWED), settled (EXPLORATION_SETTLED), the branch at its snapshot (SNAPSHOT_CURRENT), a
 * dispatch in flight or a hand-back not taken into account (DISPATCH_IN_FLIGHT).
 */
export async function pmResnapshotExploration(ctx: ProcessContext, req: { readonly mission: string; readonly exploration: string; readonly words?: string | null; readonly repair?: ChangeRepair | null; readonly command?: 'repair' }): Promise<Resnapshotted> {
  const mission = req.mission as MissionId;
  const x = req.exploration;
  const data = ctx.memory.data;
  const before = ctx.memory.read((db) => fold(eventsOf(db, data, mission, x)));
  if (before.defined === null) throw new ProcessError('NOT_ALLOWED', `mission ${req.mission} has no exploration ${x}`);
  // the state's refusals before git is read; the write checks them again
  ctx.memory.read((db) => refuse(db, data, req.mission, x, before));
  const snap = await ctx.actions().snapshot({ mission, purpose: `exploration-${x}` });
  const n = before.resnapshots.length + 1;
  const r = ctx.memory.write(
    { op: `resnapshot-exploration:${req.mission}:${x}:${n}:${snap.commit}`, payload: { mission: req.mission, exploration: x, n, commit: snap.commit, words: req.words ?? null }, command: req.command === 'repair' ? 'repair' : 'resnapshot-exploration', filler: ctx.filler },
    (tx) => {
      const events = eventsOf(tx, tx.data, mission, x);
      const s = fold(events);
      refuse(tx, tx.data, req.mission, x, s);
      // 4.1.3 (E-5): the repair this change answers, recorded in the same write
      let repair: { readonly id: string; readonly record: BaseRecord } | null = null;
      if (req.repair !== undefined && req.repair !== null && req.words !== undefined && req.words !== null) {
        let body;
        try {
          body = changeFormRepair(rows(tx, { mission, line: REPAIRS_LINE, event: 'repair' }).length, { words: req.words, kind: req.repair.kind, text: req.repair.text, exploration: x });
        } catch (err) {
          throw new ProcessError('NOT_ALLOWED', (err as Error).message);
        }
        repair = { id: body.id, record: { kind: 'flow.event', mission, line: REPAIRS_LINE, event: 'repair', key: body.id, body: tx.data.put(canonicalJson(body)) as ContentHash } };
      }
      const e = resnapshotEntries(s, { path: snap.path, commit: snap.commit }, (d) => tx.data.put(d), { by: 'pm', words: req.words ?? null, answers: repair?.id ?? null });
      if (e === null) throw new ProcessError('NOT_ALLOWED', `the target branch is at ${snap.commit}, the snapshot exploration ${x} of ${req.mission} reads already: nothing to take again`);
      if (repair !== null) appendRecords(tx, [repair.record]);
      record(tx, e);
      const after = fold([...events, { event: e.event.event, key: e.event.key, body: e.body }]);
      return { snapshot: e.body.snapshot.commit, previous: e.body.previous.commit, n: e.body.n, olderEvidence: [...after.evidence.keys()].filter((id) => olderSnapshotEvidence(after, id)).sort(), repair: repair?.id ?? null };
    },
  );
  await advance(ctx, mission, { dispatch: null, task: null, step: `mp pm resnapshot-exploration ${req.mission} ${x}` });
  return r;
}
