// The fake model for the end-to-end mission (test/e2e-mission.test.ts): one scripted model
// service (test/seat-fakemodel.ts) behind every seat's real metering proxy. Each main request
// names its launch in the card the seat host sends as the first message ("# Card for launch
// <id>"); the script reads that launch's stamped card from the content store (through the
// seat directory's host.json, which the scheduler writes at admission) and answers the way a
// cooperative seat of that kind would: it reads every must-read material page, does the kind's
// work through its tools (the Constructor writes the module change), then hands back a valid
// result built with the flow's scripted helpers (src/flow/scripted.ts) from the real card.
//
// Nothing here calls a real model.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ContentStore } from '../../src/ledger/content.ts';
import { contentHash } from '../../src/common/ids.ts';
import { architect, cal1Pass, cal2Pass, constructorDone, feasible, reviewer, secretary } from '../../src/flow/scripted.ts';
import type { DetailedPlanDoc } from '../../src/flow/plandoc.ts';
import { startFakeModel, type FakeModel, type FakeReply, type FakeRequest } from '../seat-fakemodel.ts';

export type SeatBehavior = 'pass' | 'stall-after-work';

export interface SeatPlan {
  /** The detailed plan the Architect hands back (built from its card's mission). */
  readonly detailedPlan: (mission: string) => DetailedPlanDoc;
  /** The files the Constructor writes (path relative to the snapshot root → content). */
  readonly constructorFiles: Readonly<Record<string, string>>;
  /** Commands the Constructor runs (run_command) after writing its files. */
  readonly constructorCommands?: readonly string[];
  /** Per card kind (default 'pass'). 'stall-after-work': the seat does its work, then its next request never gets an answer. */
  readonly behavior?: Readonly<Record<string, SeatBehavior>>;
  /**
   * Another hand-back for the n-th launch (1-based) of a card kind, built from its real card;
   * undefined: the cooperative default.
   */
  readonly handBack?: (seat: string, card: Record<string, unknown>, n: number) => unknown;
  /** The n-th launch (1-based) of a card kind gets a request error from the model service (an environment failure; a 401 or 5xx would be retried by Claude Code for minutes). */
  readonly modelError?: (seat: string, n: number) => boolean;
}

export interface SeatLogEntry {
  readonly at: number;
  readonly launch: string;
  readonly seat: string;
  readonly step: number;
  readonly reply: string;
  /** The tail of the conversation's last user turn (tool results: refusals show up here). */
  readonly lastUser: string;
}

export interface FakeSeats {
  readonly url: string;
  readonly model: FakeModel;
  readonly log: SeatLogEntry[];
  /** Launches by card kind, in the order their first main request arrived. */
  readonly launches: Map<string, string[]>;
  /** Launches whose seat is stalled right now (scenario 2). */
  readonly stalled: Set<string>;
  close(): Promise<void>;
}

type Card = Record<string, unknown> & { seat: string; launch: string; materials?: Array<{ id: string; pages: number; mustRead: boolean }> };

const tool = (name: string, input: unknown): FakeReply => ({ kind: 'tool', name: `mcp__program__${name}`, input });

function lastUserTurn(req: FakeRequest): string {
  const messages = Array.isArray(req.body?.['messages']) ? (req.body?.['messages'] as Array<{ role?: string; content?: unknown }>) : [];
  const last = [...messages].reverse().find((m) => m.role === 'user');
  if (last === undefined) return '';
  const c = last.content;
  if (typeof c === 'string') return c.slice(-600);
  if (!Array.isArray(c)) return '';
  return c
    .map((b: Record<string, unknown>) => {
      if (b['type'] === 'text') return String(b['text'] ?? '');
      if (b['type'] === 'tool_result') {
        const inner = b['content'];
        if (typeof inner === 'string') return inner;
        if (Array.isArray(inner)) return inner.map((x: Record<string, unknown>) => String(x['text'] ?? '')).join('\n');
      }
      return '';
    })
    .join('\n')
    .slice(-600);
}

export async function startFakeSeats(o: { readonly stateDir: string; readonly contentRoot: string; readonly plan: SeatPlan }): Promise<FakeSeats> {
  const content = new ContentStore(o.contentRoot);
  const cards = new Map<string, Card>();
  const log: SeatLogEntry[] = [];
  const launches = new Map<string, string[]>();
  const stalled = new Set<string>();

  const cardOf = (launch: string): Card | null => {
    const known = cards.get(launch);
    if (known !== undefined) return known;
    const hostPath = join(o.stateDir, 'seats', launch, 'host.json');
    if (!existsSync(hostPath)) return null;
    const host = JSON.parse(readFileSync(hostPath, 'utf8')) as { card: string };
    const card = JSON.parse(content.get(contentHash(host.card)).toString('utf8')) as Card;
    cards.set(launch, card);
    return card;
  };

  /** The whole action list of a cooperative seat of this card's kind. */
  const actions = (card: Card, launch: string): FakeReply[] => {
    const reads: FakeReply[] = [];
    for (const m of card.materials ?? []) if (m.mustRead) for (let p = 1; p <= m.pages; p++) reads.push(tool('read_material', { material: m.id, page: p }));
    const c = card as never;
    const n = (launches.get(card.seat) ?? []).indexOf(launch) + 1;
    const other = o.plan.handBack?.(card.seat, card, n);
    if (other !== undefined) {
      const work = card.seat === 'constructor' ? Object.entries(o.plan.constructorFiles).map(([path, data]) => tool('write_file', { path, content: data })) : [];
      return [...reads, ...work, tool('submit_result', other)];
    }
    switch (card.seat) {
      case 'calibrator-1':
        return [...reads, tool('submit_result', cal1Pass(c))];
      case 'architect-decompose':
        return [...reads, tool('submit_result', architect(o.plan.detailedPlan(String(card['mission']))))];
      case 'architect-feasibility':
        return [...reads, tool('submit_result', feasible())];
      case 'calibrator-2':
        return [...reads, tool('submit_result', cal2Pass(c))];
      case 'constructor':
        return [
          ...reads,
          ...Object.entries(o.plan.constructorFiles).map(([path, data]) => tool('write_file', { path, content: data })),
          ...(o.plan.constructorCommands ?? []).map((command) => tool('run_command', { command, timeout_ms: 120_000 })),
          tool('submit_result', constructorDone()),
        ];
      case 'reviewer':
        return [...reads, tool('submit_result', reviewer(c, 'pass'))];
      case 'secretary': {
        const options = (card['options'] as Array<{ id: string }> | undefined) ?? [];
        return [...reads, tool('submit_result', secretary(c, (options[0]?.id ?? 'ask-user') as never))];
      }
      default:
        return [{ kind: 'text', text: `fake model: no script for card kind ${card.seat}` }];
    }
  };

  const model = await startFakeModel((req) => {
    const m = /# Card for launch (\S+)/.exec(req.userText);
    const launch = m?.[1] ?? '';
    const card = launch === '' ? null : cardOf(launch);
    let reply: FakeReply;
    if (card === null) {
      reply = { kind: 'text', text: 'fake model: unknown launch' };
    } else {
      if (!(launches.get(card.seat) ?? []).includes(launch)) launches.set(card.seat, [...(launches.get(card.seat) ?? []), launch]);
      const list = actions(card, launch);
      const behavior = o.plan.behavior?.[card.seat] ?? 'pass';
      const n = (launches.get(card.seat) ?? []).indexOf(launch) + 1;
      if (o.plan.modelError?.(card.seat, n) === true) {
        reply = { kind: 'error', status: 400, type: 'invalid_request_error', message: 'fake model: this request is refused (an environment failure for the test)' };
      } else if (behavior === 'stall-after-work' && req.step >= list.length - 1) {
        stalled.add(launch);
        reply = { kind: 'stall' };
      } else reply = list[req.step] ?? { kind: 'text', text: 'Done.' };
    }
    log.push({
      at: Date.now(),
      launch,
      seat: card?.seat ?? '?',
      step: req.step,
      reply: reply.kind === 'tool' ? reply.name.replace(/^mcp__program__/, '') : reply.kind,
      lastUser: lastUserTurn(req),
    });
    return reply;
  });
  return { url: model.url, model, log, launches, stalled, close: () => model.close() };
}

/** The fake model's conversation log, for a failure message. */
export function seatLogText(s: FakeSeats, last = 40): string {
  return s.log
    .slice(-last)
    .map((e) => `${new Date(e.at).toISOString().slice(11, 23)} ${e.seat} ${e.launch} step ${e.step} -> ${e.reply}${e.lastUser !== '' ? `\n    last user turn: ${e.lastUser.replace(/\s+/g, ' ').slice(-300)}` : ''}`)
    .join('\n');
}
