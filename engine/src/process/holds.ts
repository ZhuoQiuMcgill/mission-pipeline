// 4.4 (G6; the plan's F6, problem P6): holds. "Not this yet" is a record that harms no other work and
// that any session can read: `hold.placed` and `hold.released` (memory/events.ts).
//
//   who        The order of work within the plan is the Secretary's: it places and releases holds for
//              its own reasons, with no words (`mp sec hold`). The PM places one when the user said
//              so, with the words (`mp pm hold`). Nothing refuses either; a missing piece warns.
//   subjects   one task (its Constructor steps: no new attempt starts; its reviews and decisions go
//              on); one queued step, by its id (a review, a repair's Architect step); a named resource
//              (every step that leases it or needs it as a capability); everything (every step but a
//              Secretary decision). `mission` narrows a task, a resource or everything to one mission.
//   release    while a named task is not accepted (`after`), from a time, until a time, or by hand. A
//              condition is evaluated when the ready list is built and writes nothing; `mp sec wait`
//              wakes at the next such time (secretary.ts SECRETARY_WAKE).
//   effect     a held step is not ready, and its claim is refused in the claim's own write. Nothing
//              else: a dispatch in flight, a hand-back, a run, a delivery and a landing are untouched,
//              and the stop is not used for it.
//   disk       (H-3) config.json `limits: { worktrees, freeBytes }`: while one is passed, new
//              Constructor steps are held with the reason shown. The default sets none.

import { readdirSync } from 'node:fs';
import { canonicalJson } from '../common/hash.ts';
import type { MissionId } from '../common/ids.ts';
import { flowEvents, flowMissions, taskInfo, wordsEntry, type Db } from '../memory/index.ts';
import type { HoldSubject, ResidentEvent } from '../memory/events.ts';
import { notAllowed } from '../memory/resident.ts';
import { lineAcceptance, taskLineage } from '../flow/execution.ts';
import { taskLine } from '../flow/plandoc.ts';
import type { ProcessContext } from './context.ts';
import type { TaskSpecDoc } from './ports.ts';

export type { HoldSubject } from '../memory/events.ts';
export type HoldPlaced = Extract<ResidentEvent, { kind: 'hold.placed' }>;
export type HoldReleased = Extract<ResidentEvent, { kind: 'hold.released' }>;

type Texts = { text(hash: string): string };

/** One hold as the log has it: its placing, and its release by hand when there is one. */
export interface HoldRow {
  readonly placed: HoldPlaced;
  readonly rev: number;
  readonly at: number;
  readonly released: { readonly record: HoldReleased; readonly rev: number; readonly at: number } | null;
}

/** in force; waiting for its `from` time; over (its `until` time passed, or its `after` task is accepted); released by hand. */
export type HoldState = 'in-force' | 'waiting' | 'over' | 'released';

/** What a held step carries of each hold that holds it (structured: `mp sec next --json`). */
export interface HoldRef {
  readonly id: string;
  readonly reason: string;
  readonly by: 'pm' | 'secretary';
  readonly words: string | null;
  readonly until: number | null;
  readonly after: string | null;
}

/** Every hold, in the order placed, from one read of the log. */
export function holdRows(db: Db): HoldRow[] {
  const rows = db.stmt("SELECT rev, kind, record, committed_at FROM log WHERE kind IN ('hold.placed', 'hold.released') ORDER BY rev").all() as Array<{ rev: number; kind: string; record: string; committed_at: number }>;
  const out = new Map<string, HoldRow>();
  for (const r of rows) {
    const rec = JSON.parse(r.record) as HoldPlaced | HoldReleased;
    if (rec.kind === 'hold.placed') {
      if (!out.has(rec.hold)) out.set(rec.hold, { placed: rec, rev: Number(r.rev), at: Number(r.committed_at), released: null });
    } else {
      const h = out.get(rec.hold);
      if (h !== undefined && h.released === null) out.set(rec.hold, { ...h, released: { record: rec, rev: Number(r.rev), at: Number(r.committed_at) } });
    }
  }
  return [...out.values()];
}

/** A time as people read it: "2026-11-28 09:00 UTC". */
export function timeText(ms: number): string {
  return `${new Date(ms).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

/**
 * A time of `--from` / `--until`: an ISO 8601 date and time (`2026-11-28T09:00Z`; without a zone, local
 * time), or `+<n>m`, `+<n>h`, `+<n>d` from now. Null: not a time.
 */
export function parseHoldTime(text: string, now: number): number | null {
  const rel = /^\+([0-9]{1,6})([mhd])$/.exec(text.trim());
  if (rel !== null) return now + Number(rel[1]) * (rel[2] === 'm' ? 60_000 : rel[2] === 'h' ? 3_600_000 : 86_400_000);
  if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}/.test(text.trim())) return null;
  const t = Date.parse(text.trim());
  return Number.isFinite(t) ? t : null;
}

/**
 * The task an `after` names: `<mission>/<task>`, or `<task>` in the hold's mission (none: in every mission
 * that has it). A task id holds no "/" (flow/plandoc.ts), so the two forms never meet.
 */
export function afterTask(after: string, mission: string | null): { readonly task: string; readonly mission: string | null } {
  const i = after.indexOf('/');
  return i < 0 ? { task: after, mission } : { task: after.slice(i + 1), mission: after.slice(0, i) };
}

/** Whether a task is accepted now: in its mission, or (no mission) in every mission that has its line, and at least one does. */
function taskAccepted(db: Db, data: Texts, after: string, holdMission: string | null): boolean {
  const { task, mission } = afterTask(after, holdMission);
  const line = taskLine(task);
  const missions = mission !== null ? [mission] : flowMissions(db);
  let seen = 0;
  for (const m of missions) {
    const events = flowEvents(db, { mission: m as MissionId, line, limit: 10_000 }).map((e) => ({ revision: Number(e.revision), event: e.event, key: e.key, body: JSON.parse(data.text(e.body)) as unknown }));
    if (events.length === 0) continue;
    seen++;
    if (lineAcceptance(events).product === null) return false;
  }
  return seen > 0;
}

/** Whether a task has a line in a mission (or in any mission). */
function taskKnown(db: Db, task: string, mission: string | null): boolean {
  return (mission !== null ? [mission] : flowMissions(db)).some((m) => flowEvents(db, { mission: m as MissionId, line: taskLine(task), limit: 1 }).length > 0);
}

/** A hold's state now and, unless it is in force, why (evaluated, never written). */
export function holdState(db: Db, data: Texts, h: HoldRow, now: number): { readonly state: HoldState; readonly note: string | null } {
  const p = h.placed;
  if (h.released !== null) {
    const r = h.released.record;
    return { state: 'released', note: `released by hand by ${who(r.by, r.words)} at ${timeText(h.released.at)}${r.reason !== null ? `: ${r.reason}` : ''}` };
  }
  if (p.until !== null && now >= p.until) return { state: 'over', note: `its end time ${timeText(p.until)} has passed` };
  if (p.after !== null && taskAccepted(db, data, p.after, p.mission)) return { state: 'over', note: `task ${p.after} is accepted` };
  if (p.from !== null && now < p.from) return { state: 'waiting', note: `in force from ${timeText(p.from)}` };
  return { state: 'in-force', note: null };
}

/** The holds in force now (one read). */
export function holdsInForce(db: Db, data: Texts, now: number): HoldRow[] {
  return holdRows(db).filter((h) => h.released === null && holdState(db, data, h, now).state === 'in-force');
}

function who(by: 'pm' | 'secretary', words: string | null): string {
  return by === 'pm' ? `the PM${words !== null ? ` on ${words}` : ''}` : 'the Secretary';
}

/** What a hold names, for people. */
export function subjectText(p: Pick<HoldPlaced, 'subject' | 'mission'>): string {
  const s = p.subject;
  const inMission = p.mission !== null ? ` in ${p.mission}` : '';
  switch (s.kind) {
    case 'task':
      return `the Constructor steps of task ${s.task}${p.mission !== null ? ` in ${p.mission}` : ' (in every mission that has it)'}`;
    case 'step':
      return `step ${s.step}`;
    case 'resource':
      return `every step that leases or needs ${s.resource}${inMission}`;
    case 'all':
      return `every step${p.mission !== null ? ` of ${p.mission}` : ''} except a Secretary decision`;
  }
}

/** How a hold ends: by hand always (with the command of who reads it: `mp pm` or `mp sec`); at its end time; when its task is accepted. */
export function endsText(p: Pick<HoldPlaced, 'hold' | 'until' | 'after'>, group: 'pm' | 'sec' = 'pm'): string {
  return `released by hand (mp ${group} hold release ${p.hold})${p.until !== null ? `, at ${timeText(p.until)}` : ''}${p.after !== null ? `, or when task ${p.after} is accepted` : ''}`;
}

/** The holds in force that hold one queued step. A Secretary decision is held only by a hold that names its step. */
export function holdsOn(active: readonly HoldRow[], q: { readonly task: string; readonly mission: string; readonly lineage: string }, spec: TaskSpecDoc): HoldRow[] {
  const seat = spec.card.seat;
  return active.filter(({ placed: h }) => {
    const s = h.subject;
    if (s.kind === 'step') return s.step === q.task;
    if (seat === 'secretary') return false;
    if (h.mission !== null && h.mission !== q.mission) return false;
    if (s.kind === 'all') return true;
    if (s.kind === 'task') return seat === 'constructor' && q.lineage === taskLineage(q.mission, s.task);
    return (spec.exclusive ?? []).includes(s.resource) || (spec.capabilities ?? []).includes(s.resource);
  });
}

export function holdRef(p: HoldPlaced): HoldRef {
  return { id: p.hold, reason: p.reason, by: p.by, words: p.words, until: p.until, after: p.after };
}

/** Why a step is held, by the holds that hold it (a long reason is cut here; the hold's `reason` and `mp read holds` carry it whole). */
export function heldWhy(hs: readonly HoldRow[], group: 'pm' | 'sec' = 'pm'): string {
  const cut = (s: string): string => { const one = s.replace(/\s+/g, ' ').trim(); return one.length <= 200 ? one : `${one.slice(0, 199)}…`; };
  return hs.map(({ placed: p }) => `hold ${p.hold} (${who(p.by, p.words)}): ${cut(p.reason)}; it waits until it is ${endsText(p, group)}`).join('; ');
}

/**
 * 4.4 (G6, F6): what holds a queued step beyond 4.3's reasons: the holds in force that name it, or a disk
 * limit passed (a new Constructor step only). Null: neither. `group`: whose commands the text names.
 */
export function heldByHolds(active: readonly HoldRow[], disk: string | null, q: { readonly task: string; readonly mission: string; readonly lineage: string }, spec: TaskSpecDoc, group: 'pm' | 'sec' = 'pm'): { readonly why: string; readonly wi: null; readonly holds?: readonly HoldRef[]; readonly diskLimit?: true } | null {
  const hs = holdsOn(active, q, spec);
  if (hs.length > 0) return { why: heldWhy(hs, group), wi: null, holds: hs.map((h) => holdRef(h.placed)) };
  if (disk !== null && spec.card.seat === 'constructor') return { why: disk, wi: null, diskLimit: true };
  return null;
}

// ---------------------------------------------------------------- disk limits (H-3)

/** Bytes for people: B, KB, MB, GB (powers of 1024, one decimal). */
export function bytesText(n: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = n;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u++;
  }
  return u === 0 ? `${n} B` : `${v.toFixed(1)} ${units[u]}`;
}

/** The worktree folders under `.mission-pipeline/worktrees/`. */
export function worktreeFolders(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort();
  } catch {
    return [];
  }
}

/** 4.4 (F6, H-3): the disk limit passed now, as the reason new Constructor steps wait; null when none is set or none is passed. */
export function diskLimitPassed(ctx: Pick<ProcessContext, 'limits' | 'diskFree' | 'memory'>): string | null {
  const l = ctx.limits;
  if (l.worktrees === undefined && l.freeBytes === undefined) return null;
  const out: string[] = [];
  if (l.worktrees !== undefined) {
    const n = worktreeFolders(ctx.memory.paths.worktrees).length;
    if (n >= l.worktrees) out.push(`${n} worktree(s) are on disk, at or above limits.worktrees (${l.worktrees})`);
  }
  if (l.freeBytes !== undefined) {
    const free = ctx.diskFree();
    if (free !== null && free < l.freeBytes) out.push(`${bytesText(free)} is free on the project's disk, below limits.freeBytes (${bytesText(l.freeBytes)})`);
  }
  return out.length === 0 ? null : `a disk limit of config.json is passed: ${out.join('; ')}; new Constructor steps wait until it is not (mp read scratch lists what takes the space)`;
}

// ---------------------------------------------------------------- place and release

export interface HoldRequest {
  readonly subject: HoldSubject;
  readonly mission?: string | null;
  readonly after?: string | null;
  /** As given: an ISO time or `+<n>m|h|d` (parseHoldTime). */
  readonly from?: string | null;
  readonly until?: string | null;
  readonly reason: string;
  /** The user's words entry a PM hold rests on. */
  readonly words?: string | null;
}

export interface Placed {
  readonly hold: string;
  /** The same hold was in force already (a command run again): nothing new was recorded. */
  readonly repeated: boolean;
  readonly by: 'pm' | 'secretary';
  readonly mission: string | null;
  readonly from: number | null;
  readonly until: number | null;
  readonly warnings: readonly string[];
}

/** The longest reason a hold keeps. */
export const HOLD_REASON_MAX = 2_000;

/**
 * `mp pm hold add` / `mp sec hold add`: a hold placed. The same hold placed again while it is in force or
 * waiting is that hold (a retry without its operation id). What is missing or unknown warns; nothing in
 * the state of the work refuses it.
 */
export function placeHold(ctx: ProcessContext, o: HoldRequest & { readonly op: string }): Placed {
  const by: 'pm' | 'secretary' = ctx.secretary !== null ? 'secretary' : 'pm';
  const reason = o.reason.trim().slice(0, HOLD_REASON_MAX);
  if (reason === '') notAllowed('a hold says why: --reason "<the reason>"');
  const now = ctx.now();
  const time = (t: string | null | undefined, flag: string): number | null => {
    if (t === null || t === undefined) return null;
    const ms = parseHoldTime(t, now);
    if (ms === null) notAllowed(`${flag} is a time: an ISO date and time such as 2026-11-28T09:00Z, or +<n>m, +<n>h, +<n>d from now; not ${JSON.stringify(t)}`);
    return ms;
  };
  const from = time(o.from, '--from');
  const until = time(o.until, '--until');
  const payload = { subject: o.subject, mission: o.mission ?? null, after: o.after ?? null, from: o.from ?? null, until: o.until ?? null, reason: o.reason, words: o.words ?? null };
  const out = ctx.memory.write({ op: `hold:${o.op}`, payload, command: by === 'pm' ? 'hold add' : 'sec hold add', filler: ctx.filler }, (tx) => {
    if (o.words != null && wordsEntry(tx, o.words) === null) notAllowed(`no words entry ${o.words} (mp pm say records the user's message)`);
    const notes: string[] = [];
    let mission = o.mission ?? null;
    if (o.subject.kind === 'step') {
      const t = taskInfo(tx, o.subject.step);
      if (t === null) notes.push(`step ${o.subject.step} is not known: the hold applies once a step of that id is queued`);
      else {
        mission ??= t.mission;
        if (t.state !== 'queued') notes.push(`step ${o.subject.step} is not queued now (${t.state}): the hold applies when it is queued again; a dispatch in flight goes on`);
      }
    }
    const rec: Omit<HoldPlaced, 'hold'> = { kind: 'hold.placed', subject: o.subject, mission, after: o.after ?? null, from, until, reason, by, generation: ctx.secretary, words: o.words ?? null };
    const rows = holdRows(tx);
    const key = (p: Omit<HoldPlaced, 'hold'> | HoldPlaced): string => canonicalJson([p.subject, p.mission, p.after, p.from, p.until, p.reason, p.by, p.words]);
    const same = rows.find((r) => r.released === null && key(r.placed) === key(rec) && holdState(tx, tx.data, r, now).state !== 'over');
    if (same !== undefined) return { hold: same.placed.hold, repeated: true, by, mission, from, until, warnings: notes };
    const hold = `H-${rows.length + 1}`;
    tx.append({ ...rec, hold });
    return { hold, repeated: false, by, mission, from, until, warnings: notes };
  });
  // what the record cannot tell yet, said once (read after the write; it refuses nothing)
  const warnings = [...out.warnings];
  ctx.memory.read((db) => {
    if (by === 'pm' && (o.words ?? null) === null) warnings.push('no --words: a PM hold rests on what the user said (mp pm say records it as W-<n>); it is recorded without them');
    if (o.subject.kind === 'task' && !taskKnown(db, o.subject.task, out.mission)) warnings.push(`task ${o.subject.task} has no line${out.mission !== null ? ` in ${out.mission}` : ''} yet: the hold applies to its Constructor steps once it has some`);
    const after = o.after == null ? null : afterTask(o.after, out.mission);
    if (after !== null && !taskKnown(db, after.task, after.mission)) warnings.push(`task ${after.task} has no line${after.mission !== null ? ` in ${after.mission}` : ''} yet: the hold stays until it is accepted or released by hand`);
  });
  if (until !== null && until <= now) warnings.push(`its end time ${timeText(until)} has passed: it holds nothing`);
  else if (from !== null && until !== null && from >= until) warnings.push('--from is not before --until: it is never in force');
  return { ...out, warnings };
}

export interface ReleasedHold {
  readonly hold: string;
  /** False: it was released before (by `releasedBy`); nothing new was recorded. */
  readonly released: boolean;
  readonly releasedBy: 'pm' | 'secretary';
  readonly warnings: readonly string[];
}

/** `mp pm hold release <H>` / `mp sec hold release <H>`: a hold released by hand. A hold released already is a no-op. */
export function releaseHold(ctx: ProcessContext, o: { readonly op: string; readonly hold: string; readonly reason?: string | null; readonly words?: string | null }): ReleasedHold {
  const by: 'pm' | 'secretary' = ctx.secretary !== null ? 'secretary' : 'pm';
  const reason = o.reason === null || o.reason === undefined || o.reason.trim() === '' ? null : o.reason.trim().slice(0, HOLD_REASON_MAX);
  return ctx.memory.write({ op: `hold-release:${o.op}`, payload: { hold: o.hold, reason: o.reason ?? null, words: o.words ?? null }, command: by === 'pm' ? 'hold release' : 'sec hold release', filler: ctx.filler }, (tx) => {
    if (o.words != null && wordsEntry(tx, o.words) === null) notAllowed(`no words entry ${o.words} (mp pm say records the user's message)`);
    const row = holdRows(tx).find((r) => r.placed.hold === o.hold);
    if (row === undefined) notAllowed(`no hold ${o.hold} (mp read holds --all lists them)`);
    if (row.released !== null) return { hold: o.hold, released: false, releasedBy: row.released.record.by, warnings: [] };
    tx.append({ kind: 'hold.released', hold: o.hold, by, generation: ctx.secretary, words: o.words ?? null, reason });
    // the user's words settle what they decided: a Secretary that releases the PM's hold on them is told so
    const warnings = by === 'secretary' && row.placed.by === 'pm' && row.placed.words !== null ? [`${o.hold} was placed by the PM on the user's words ${row.placed.words}: its release is the PM's; if the user did not lift it, tell the PM (mp sec ask-pm)`] : [];
    return { hold: o.hold, released: true, releasedBy: by, warnings };
  });
}

// ---------------------------------------------------------------- reads

export interface HoldView {
  readonly id: string;
  readonly subject: HoldSubject;
  readonly mission: string | null;
  readonly after: string | null;
  readonly from: number | null;
  readonly until: number | null;
  readonly reason: string;
  readonly by: 'pm' | 'secretary';
  readonly generation: string | null;
  readonly words: string | null;
  readonly placedAt: number;
  readonly state: HoldState;
  /** Why it is waiting, over or released; null while in force. */
  readonly note: string | null;
  readonly released: { readonly by: 'pm' | 'secretary'; readonly generation: string | null; readonly words: string | null; readonly reason: string | null; readonly at: number } | null;
}

/** Every hold with its state now, in the order placed (one read; nothing written). */
export function holdViews(db: Db, data: Texts, now: number): HoldView[] {
  return holdRows(db).map((h) => {
    const p = h.placed;
    const s = holdState(db, data, h, now);
    const r = h.released;
    return { id: p.hold, subject: p.subject, mission: p.mission, after: p.after, from: p.from, until: p.until, reason: p.reason, by: p.by, generation: p.generation, words: p.words, placedAt: h.at, state: s.state, note: s.note, released: r === null ? null : { by: r.record.by, generation: r.record.generation, words: r.record.words, reason: r.record.reason, at: r.at } };
  });
}

/**
 * 4.4 (G6, F8): `mp sec wait` wakes at a hold's time: a `from` or `until` of a hold not released by hand
 * that falls after the commit of revision `since` and at or before `now`.
 */
export function holdTimeReached(db: Db, now: number, since: number): boolean {
  const t0 = Number((db.stmt('SELECT committed_at FROM log WHERE rev = ?').get(since) as { committed_at: number } | undefined)?.committed_at ?? 0);
  return holdRows(db).some((h) => h.released === null && [h.placed.from, h.placed.until].some((t) => t !== null && t > t0 && t <= now));
}
