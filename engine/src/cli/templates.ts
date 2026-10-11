// `mp pm plan template <mission>`: an annotated, valid PM plan skeleton (design 4.1 §6.1; v51 §3.3,
// §3.10, §4.3), prefilled with the mission's requirement items in force and the words entries they
// quote. The annotations are `_note` keys, which the plan's schema ignores (they are dropped when
// the plan is recorded), so the skeleton validates as it is and the PM edits it in place.

import type { MissionId } from '../common/ids.ts';
import { REQUIREMENTS_LINE, PLAN_LINE } from '../flow/plandoc.ts';
import { flowEvents, latestUserWords, wordsOfMessage } from '../memory/index.ts';
import type { ProcessContext } from '../process/index.ts';

interface ItemInForce {
  readonly id: string;
  readonly type: string;
  readonly text: string;
  readonly words: string | null;
  readonly quote: string | null;
}

/** The mission's requirement items in force: the latest version of each line, not withdrawn. */
function itemsInForce(ctx: ProcessContext, mission: string): ItemInForce[] {
  const data = ctx.memory.data;
  return ctx.memory.read((db) => {
    const latest = new Map<string, ItemInForce>();
    const withdrawn = new Set<string>();
    for (const e of flowEvents(db, { mission: mission as MissionId, line: REQUIREMENTS_LINE, limit: 10_000 })) {
      let b: Record<string, any>;
      try {
        b = JSON.parse(data.text(e.body)) as Record<string, any>;
      } catch {
        continue;
      }
      const line = String(b['line'] ?? '');
      // a withdrawn line stays withdrawn, as the engine reads it (a later version does not bring it back)
      if (e.event === 'withdrawn') withdrawn.add(line);
      if (e.event !== 'item') continue;
      const src = (b['source'] ?? {}) as Record<string, unknown>;
      latest.set(line, {
        id: line.replace(new RegExp(`^item\\.${mission.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.`), ''),
        type: String(b['type'] ?? 'goal'),
        text: String(b['text'] ?? ''),
        words: typeof src['words'] === 'string' ? src['words'] : null,
        quote: typeof src['quote'] === 'string' ? src['quote'] : null,
      });
    }
    return [...latest.entries()].filter(([line]) => !withdrawn.has(line)).map(([, i]) => i);
  });
}

export interface PlanTemplate {
  readonly template: Record<string, unknown>;
  /** The words entries the batch aligns (for `--words`). */
  readonly words: readonly string[];
  readonly items: readonly ItemInForce[];
}

export function planTemplate(ctx: ProcessContext, mission: string): PlanTemplate {
  const items = itemsInForce(ctx, mission);
  const round = ctx.memory.read((db) => {
    const last = flowEvents(db, { mission: mission as MissionId, line: PLAN_LINE, event: 'pm-batch', limit: 10_000 }).at(-1);
    if (last === undefined) return 1;
    try {
      return Number((JSON.parse(ctx.memory.data.text(last.body)) as { round?: number }).round ?? 1);
    } catch {
      return 1;
    }
  });
  const latestWords = ctx.memory.read((db) => {
    const l = latestUserWords(db, 1)[0];
    return l === undefined ? null : (wordsOfMessage(db, l.message)?.words ?? null);
  });
  const words = [...new Set(items.map((i) => i.words).filter((w): w is string => w !== null))];
  if (words.length === 0 && latestWords !== null) words.push(latestWords);
  const results = items.filter((i) => i.type !== 'authorization');
  const elements: Array<Record<string, unknown>> = results.map((i, k) => ({
    id: `e${k + 1}`,
    kind: 'deliverable',
    text: i.text,
    provenance: i.words !== null && i.quote !== null ? { by: 'user', words: i.words, quote: i.quote } : { by: 'pm' },
    after: [],
    items: [i.id],
  }));
  if (elements.length === 0) {
    elements.push({ id: 'e1', kind: 'deliverable', text: '<what the user gets, at the level of results>', provenance: latestWords !== null ? { by: 'user', words: latestWords, quote: '<the user\'s words, verbatim from that entry>' } : { by: 'pm' }, after: [], items: [] });
  }
  (elements[0] as Record<string, unknown>)['_note'] =
    'One element per result the user gets, at the level of results (no tasks). kind: deliverable | phase | behavior | constraint | exploration. provenance: {"by": "user", "words": "W-<n>", "quote": "<verbatim from that entry>"} when the user said it, or {"by": "pm"} for a PM addition. items: the requirement items it rests on. after: the explorations it waits for. Delete every "_note" key or keep it: they are ignored.';
  const template: Record<string, unknown> = {
    _note: `The PM plan of mission ${mission}, prefilled from its requirement items in force. Edit it, save it as plan.json, then: mp pm plan submit ${mission} --file plan.json --words ${words.length > 0 ? words.join(',') : 'W-<n>'}. Calibrator ① checks it against the user's words.`,
    format: 'mp4.pm-plan.v1',
    mission,
    round,
    order: 'free',
    elements,
    goalsBeyond: [],
    authorizations: items.filter((i) => i.type === 'authorization').map((i) => i.id),
    _note_fields:
      'round: the planning round (the same round while explorations are unsettled). order: "user" when the user set the order of the elements, else "free". goalsBeyond: the user\'s goals beyond the nearest unsettled exploration (no tasks for them). authorizations: the authorization items the plan relies on.',
    _exploration_example: {
      id: 'x1',
      kind: 'exploration',
      text: '<the question, or what to design, in the user\'s terms>',
      provenance: { by: 'user', words: words[0] ?? 'W-<n>', quote: '<verbatim>' },
      exploration: {
        id: 'X1',
        deliverable: 'a design | a method | an analysis | the answer to <question>',
        fuzzyGoal: { quote: '<the user\'s fuzzy acceptance goal, verbatim>', words: words[0] ?? 'W-<n>' },
        attackScope: ['internal contradiction', 'infeasible', 'deadlock', 'silent error', 'cost out of control', 'conflict with the user\'s words'],
        decision: { id: 'D1', type: 'direction | structure' },
        budget: { rounds: 3, micros: null },
        stop: '',
        research: false,
      },
      after: [],
      items: [],
      _note: 'An exploration is a plan element: copy this object into "elements" (with type "direction" or "structure") when the work cannot have its acceptance written in advance; elements that wait for it name it in "after". Never presume the answer. Optional in "exploration": "readingNetwork": ["<web address>", ...], the addresses a reading may cite (url:<address>); without it a reading cites no web page.',
    },
  };
  return { template, words, items };
}
