// 4.4 (G9; the final review, F4-4): a filing the user took back asks nobody. The Architect step of a filing (a new
// requirement, or a repair naming its item) whose every item was withdrawn, or that ended, is neither ready nor
// claimed: `mp pm next` holds it with the reason, and the claim's own write refuses it (the next pass cancels it).

import type { MissionId } from '../common/ids.ts';
import { flowEventExists, type Db } from '../memory/index.ts';
import type { DataStore } from '../memory/data.ts';
import { REPAIR_ENDED, REPAIRS_LINE, REQUIREMENTS_LINE } from '../flow/plandoc.ts';
import type { TaskSpecDoc } from './ports.ts';

/** Why a repair Architect step's filing is over (it ended, or every item of it is withdrawn), or null: it is not. */
export function heldByEndedFiling(db: Db, data: DataStore, spec: TaskSpecDoc): string | null {
  if (spec.card.seat !== 'architect-repair') return null;
  const id = (spec.card as { repair?: { id?: unknown } }).repair?.id;
  if (typeof id !== 'string') return null;
  const mission = spec.mission as MissionId;
  const ended = flowEventExists(db, { mission, line: REPAIRS_LINE, event: REPAIR_ENDED, key: id });
  const row = db.stmt('SELECT body FROM flow_events WHERE mission = ? AND line = ? AND event = ? AND key = ?').get(mission, REPAIRS_LINE, 'repair', id) as { body: string } | undefined;
  let body: { items?: readonly string[]; entry?: string } = {};
  try { if (row !== undefined) body = JSON.parse(data.text(row.body)) as typeof body; } catch { /* unreadable: read as a filing with no item */ }
  const items = body.items ?? [];
  const withdrawn = items.length > 0 && items.every((i) => flowEventExists(db, { mission, line: REQUIREMENTS_LINE, event: 'withdrawn', key: `item.${mission}.${i}` }));
  if (!ended && !withdrawn) return null;
  return `${body.entry === 'extend' ? 'new requirement' : 'repair'} ${id} was taken back: every item of it was withdrawn${ended ? ' and it ended' : ' (the next pass records its end)'}, so its Architect step is not run`;
}
