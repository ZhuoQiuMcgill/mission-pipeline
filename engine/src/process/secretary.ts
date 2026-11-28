import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { MissionId, ContentHash } from '../common/ids.ts';
import { canonicalJson } from '../common/hash.ts';
import { activeStops, appendRecords, dispatchInfo, factById, wordsEntry, flowEvents, listDispatches, type Db } from '../memory/index.ts';
import type { ObjectVersionRecord } from '../common/records.ts';
import { DetailedPlanDoc, amendedPlan, latestEffectiveOf, type AmendmentEntry, type StoredDetailedPlan } from '../flow/plandoc.ts';
import type { ItemVersionBody } from '../flow/requirements.ts';
import { pmOptions } from '../flow/secretary.ts';
import { taskStatus } from './ports.ts';
import { generations, liveSecretary, notAllowed, requireSecretary, requirePm, touchSecretary, writeGeneration } from '../memory/resident.ts';
import { residentRecords, wordsAuthority } from '../memory/words.ts';
import { stopCovers } from '../memory/stopTypes.ts';
import type { ProcessContext } from './context.ts';
import { cardSizeReport, pmDispatchChecked, pmNext, type Dispatched, type NextReport } from './pm.ts';
import { dispatchView, recordServed, seatCard, seatHandback } from './seat.ts';
import { listNotices, markNotices } from './notices.ts';
import { PM_NOTICE_ACTIONS } from './noticeAudience.ts';
import type { DecisionBody, EscalationBody } from '../flow/secretary.ts';
import { secretaryRoundInputs } from '../seat/cards/dynamic.ts';
import { handBackFiles } from '../seat/card.ts';
import type { SecretaryResult } from '../seat/cards/secretary.ts';

export function unconfirmedSeats(db: Db): {dispatch: string; mission: string; seat: string; stops: string[]}[] {
  const stops = activeStops(db);
  return (db.stmt("SELECT dispatch FROM dispatches WHERE state = 'in-flight' OR (state = 'released' AND released = 'abandoned') ORDER BY claimed_rev").all() as {dispatch: string}[]).map((r) => dispatchInfo(db, r.dispatch)!).filter((d) => d.state === 'in-flight' || (d.state === 'released' && d.released === 'abandoned')).flatMap((d) => {
    const covering = stops.filter((s) => stopCovers(s.scope, d.tag));
    return covering.length === 0 ? [] : [{dispatch: d.dispatch, mission: d.mission, seat: d.seat, stops: covering.map((s) => s.stop)}];
  });
}

export function stopSecretary(ctx: ProcessContext, o: {op: string; gone?: boolean}): {generation: string; stopHint: string} {
  return ctx.memory.write({op: `secretary:stop:${o.op}`, payload: o, stop: true, command: 'secretary stop'}, (tx) => {
    const g = generations(tx).filter((g) => g.state !== 'retired').at(-1);
    if (g === undefined) notAllowed('there is no pending or live Secretary to stop');
    const stops = activeStops(tx);
    const lastStop = stops.at(-1);
    if (g.state === 'live' && o.gone !== true && (lastStop === undefined || ctx.now() < Math.max(Number(lastStop.committedAt), g.lastCommandAt ?? g.createdAt) + 60_000)) notAllowed('the Secretary has not exceeded the stop’s 60 s grace; --gone records that the user says the session is gone');
    writeGeneration(tx, {...g, state: 'retired'});
    return {generation: g.generation, stopHint: g.handle === null ? `Stop ${g.name} in your harness by name, confirm its seats ended, then mp pm release <D> --ended.` : `Stop the session with handle ${g.handle} in your harness (Claude Code hint: claude stop ${shellQuote(g.handle)}). Confirm its seats ended, then mp pm release <D> --ended.`};
  });
}

export function shellQuote(text: string): string { return `'${text.replace(/'/g, `'"'"'`)}'`; }

export function channel(ctx: ProcessContext) {
  // 4.4 (G8): the notes and their replacements come from one read of the records, so a note committed in between cannot hide both
  const rows = residentRecords(ctx.memory, 'pm.note');
  const notes = new Map(rows.map((n) => [n.id, n]));
  const replaced = replacedNotes(rows);
  const replied = new Set(residentRecords(ctx.memory, 'sec.reply').map((r) => r.id));
  const questions = new Map(residentRecords(ctx.memory, 'sec.question').map((q) => [q.id, q]));
  // 4.4 (G8): a replaced note is no longer a current instruction for the Secretary
  return {notes: [...notes.values()].filter((n) => !n.acknowledged && !replaced.has(n.id)), questions: residentRecords(ctx.memory, 'pm.question').filter((q) => !replied.has(q.id)), replies: residentRecords(ctx.memory, 'pm.reply').map((r) => ({...r, question: questions.get(r.id)?.text ?? '', about: questions.get(r.id)?.about ?? null}))};
}

/** 4.4 (G8): each replaced note and the note that replaced it first. A 4.3 note replaces nothing. */
function replacedNotes(rows: ReturnType<typeof residentRecords<'pm.note'>>): Map<string, string> {
  const out = new Map<string, string>();
  for (const n of rows) if (n.replaces !== undefined && !out.has(n.replaces)) out.set(n.replaces, n.id);
  return out;
}

export interface NoteView {readonly id: string; readonly text: string; readonly words: string | null; readonly replaces: string | null; readonly state: 'current' | 'acknowledged' | 'replaced'; readonly replacedBy: string | null; readonly acknowledged: boolean}
/** 4.4 (G8): every note with its state, oldest first: replaced (by a later note), acknowledged by the Secretary, or current. */
export function pmNotes(db: Db): NoteView[] {
  // an acknowledgement appends a copy of the note: the last record of an id is its state; one read gives both
  const rows = residentRecords(db, 'pm.note');
  const latest = new Map(rows.map((n) => [n.id, n]));
  const replaced = replacedNotes(rows);
  return [...latest.values()].map((n) => {
    const by = replaced.get(n.id) ?? null;
    return {id: n.id, text: n.text, words: n.words, replaces: n.replaces ?? null, state: by !== null ? 'replaced' as const : n.acknowledged ? 'acknowledged' as const : 'current' as const, replacedBy: by, acknowledged: n.acknowledged};
  });
}

/** 4.4 (G8): the open escalations (raised, not applied) whose id a text names, as `<mission>/<id>`. A warning reads it; nothing is refused. */
export function escalationsNamedIn(db: Db, text: string): {mission: string; escalation: string}[] {
  const rows = db.stmt("SELECT mission, event, key FROM flow_events WHERE line = 'secretary' AND event IN ('escalation', 'applied') ORDER BY revision").all() as {mission: string; event: string; key: string}[];
  const applied = new Set(rows.filter((r) => r.event === 'applied').map((r) => `${r.mission}/${r.key}`));
  const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const out: {mission: string; escalation: string}[] = [];
  for (const r of rows) {
    if (r.event !== 'escalation' || applied.has(`${r.mission}/${r.key}`) || out.some((o) => o.mission === r.mission && o.escalation === r.key)) continue;
    // an id is a whole token: "rnd.4" is not named by "rnd.42"; a sentence's full stop after it still names it
    if (new RegExp(`(?<![A-Za-z0-9_.-])${escape(r.key)}(?![A-Za-z0-9_-]|\\.[A-Za-z0-9])`).test(text)) out.push({mission: r.mission, escalation: r.key});
  }
  return out;
}

export function pmNote(ctx: ProcessContext, o: {op: string; text: string; words?: string | null; replaces?: string | null}): string {
  requirePm(ctx.secretary);
  return ctx.memory.write({op: `note:${o.op}`, payload: o, command: 'note', filler: ctx.filler}, (tx) => {
    if (o.text.trim() === '') notAllowed('a note needs text');
    if (o.words != null && wordsEntry(tx, o.words) === null) notAllowed(`no words entry ${o.words}`);
    if (o.replaces != null) {
      // 4.4 (G8): a note replaces one current note; a replaced one points to its replacement
      if (!residentRecords(tx, 'pm.note').some((n) => n.id === o.replaces)) notAllowed(`no PM note ${o.replaces}`);
      const by = replacedNotes(residentRecords(tx, 'pm.note')).get(o.replaces);
      if (by !== undefined) notAllowed(`${o.replaces} was already replaced by ${by}; replace ${by} instead`);
    }
    const id = `N-${new Set(residentRecords(tx, 'pm.note').map((n) => n.id)).size + 1}`;
    tx.append({kind: 'pm.note', id, text: o.text, words: o.words ?? null, acknowledged: false, ...(o.replaces != null ? {replaces: o.replaces} : {})}); return id;
  });
}

export function pmQuestion(ctx: ProcessContext, o: {op: string; text: string}): string {
  requirePm(ctx.secretary);
  return ctx.memory.write({op: `question:${o.op}`, payload: o, command: 'ask-secretary', filler: ctx.filler}, (tx) => {
    if (o.text.trim() === '') notAllowed('a question needs text');
    const id = `Q-${residentRecords(tx, 'pm.question').length + 1}`;
    tx.append({kind: 'pm.question', id, text: o.text}); return id;
  });
}

export function secReply(ctx: ProcessContext, o: {op: string; id: string; text: string}): void {
  ctx.memory.write({op: `reply:${o.op}`, payload: o, command: 'sec reply', filler: ctx.filler}, (tx) => {
    const g = requireSecretary(tx, ctx.secretary);
    if (!residentRecords(tx, 'pm.question').some((q) => q.id === o.id)) notAllowed(`no PM question ${o.id}`);
    const prior = residentRecords(tx, 'sec.reply').find((r) => r.id === o.id);
    if (prior !== undefined) {if (prior.text !== o.text) notAllowed(`${o.id} was already answered`); return;}
    if (o.text.trim() === '') notAllowed('a reply needs text');
    tx.append({kind: 'sec.reply', id: o.id, text: o.text, generation: g.generation});
  });
}

/** Operational questions need no escalation or decision card. They carry context, not rulings. */
export function secQuestion(ctx: ProcessContext, o: {op: string; text: string; about?: string | null}): string {
  return ctx.memory.write({op: `sec-question:${o.op}`, payload: o, command: 'sec ask-pm', filler: ctx.filler}, (tx) => {
    const g = requireSecretary(tx, ctx.secretary);
    if (o.text.trim() === '') notAllowed('a question needs text');
    const id = `SQ-${residentRecords(tx, 'sec.question').length + 1}`;
    tx.append({kind: 'sec.question', id, text: o.text, about: o.about ?? null, generation: g.generation});
    return id;
  });
}

export function pmReply(ctx: ProcessContext, o: {op: string; id: string; text: string; words?: string | null}): void {
  requirePm(ctx.secretary);
  ctx.memory.write({op: `pm-reply:${o.op}`, payload: o, command: 'pm reply', filler: ctx.filler}, (tx) => {
    if (!residentRecords(tx, 'sec.question').some((q) => q.id === o.id)) notAllowed(`no Secretary question ${o.id}`);
    const prior = residentRecords(tx, 'pm.reply').find((r) => r.id === o.id);
    if (prior !== undefined) {if (prior.text !== o.text || prior.words !== (o.words ?? null)) notAllowed(`${o.id} was already answered`); return;}
    if (o.text.trim() === '') notAllowed('a reply needs text');
    if (o.words != null && wordsEntry(tx, o.words) === null) notAllowed(`no words entry ${o.words}`);
    tx.append({kind: 'pm.reply', id: o.id, text: o.text, words: o.words ?? null});
  });
}

export function secAckNote(ctx: ProcessContext, o: {op: string; id: string}): void {
  ctx.memory.write({op: `ack-note:${o.op}`, payload: o, command: 'sec ack-note', filler: ctx.filler}, (tx) => {
    requireSecretary(tx, ctx.secretary);
    const n = residentRecords(tx, 'pm.note').filter((n) => n.id === o.id).at(-1);
    if (n === undefined) notAllowed(`no PM note ${o.id}`);
    if (!n.acknowledged) tx.append({...n, acknowledged: true});
  });
}

/**
 * 4.4 (G2): what reaches the PM with a decision item: the Secretary's notice in full, its reason, each
 * option with what it does, the requirement items and words entries the work rests on (by id), and the
 * escalation's reasons shortened, with the read that gives the rest. Nothing in it is checked.
 */
export interface InboxBrief {readonly by: string | null; readonly notice: string; readonly reason: string; readonly handedOver?: string; readonly options: readonly {id: string; outcome: string}[]; readonly items: readonly string[]; readonly words: readonly string[]; readonly revised?: readonly CitedVersion[]; readonly reasons: readonly string[]; readonly more: string}
export interface InboxItem {id: string; kind: 'decision' | 'notice' | 'question' | 'reply'; mission: string | null; text: string; state: string; action: string; resolution: string; round?: number; options?: readonly string[]; facts?: unknown; about?: string | null; acknowledgeable?: boolean; brief?: InboxBrief}
function allFlow(ctx: ProcessContext) {
  return (ctx.memory.stmt('SELECT mission, line, event, key, body, revision AS rev FROM flow_events ORDER BY revision').all() as {mission: string; line: string; event: string; key: string; body: string; rev: number}[]).map((e) => ({...e, revision: Number(e.rev), mission: e.mission as MissionId, body: JSON.parse(ctx.memory.data.text(e.body)) as any}));
}
type FlowRow = ReturnType<typeof allFlow>[number];

type Decided = {notice: string; reason: string; authorization?: string | null; inputs?: readonly {line: string; version: string}[]};

/**
 * 4.4 (F9, issue 62): a Secretary decision handed back before any pass recorded it, read from its accepted
 * hand-back, with the versions its card was claimed with (what a pass records as the decision's inputs).
 */
function handedBackDecision(ctx: ProcessContext, task: string): (SecretaryResult & {inputs?: readonly {line: string; version: string}[]}) | undefined {
  const s = taskStatus(ctx.memory, ctx.memory.data, task);
  if (s?.state !== 'done' || s.handBack === null) return undefined;
  const claimed = flowEvents(ctx.memory, {mission: dispatchInfo(ctx.memory, s.handBack.dispatch)!.mission, line: `dispatch:${s.handBack.dispatch}`, event: 'claimed'})[0];
  const spec = claimed === undefined ? null : JSON.parse(ctx.memory.data.text((JSON.parse(ctx.memory.data.text(claimed.body)) as {spec: string}).spec)) as {card?: {contextItems?: {line: string; version: string}[]}};
  return {...(s.handBack.result as SecretaryResult), ...(spec?.card?.contextItems !== undefined ? {inputs: spec.card.contextItems} : {})};
}

/** An authorization the decision cites, at the version it was decided on, and the version in force now when it differs. */
export interface CitedVersion {readonly line: string; readonly decided: string; readonly current: string | null}

/**
 * 4.4 (G2): the requirement items an escalation's work rests on (its own, its task's in the plan in effect,
 * the authorization the decision cites, and the authorizations they rest on) and their words entries. A cited
 * authorization counts at the version the decision recorded, and at its current one too when it was revised.
 */
function restsOn(ctx: ProcessContext, mine: readonly FlowRow[], esc: EscalationBody, plans: Map<string, DetailedPlanDoc | null>, cited: readonly {line: string; version: string | null}[]): {items: string[]; words: string[]; revised: CitedVersion[]} {
  const items = new Set([...(esc.items ?? []), ...cited.map((c) => c.line)]);
  const taskId = esc.subject.startsWith('task:') ? esc.subject.slice('task:'.length) : null;
  const dplan = taskId === null ? undefined : mine.filter((e) => e.line === `task:${taskId}` && e.event === 'spec').at(-1)?.body.dplan as string | undefined;
  if (dplan !== undefined && !plans.has(dplan)) {
    const obj = factById(ctx.memory, 'object.version', dplan)?.record as ObjectVersionRecord | undefined;
    plans.set(dplan, obj === undefined ? null : amendedPlan(DetailedPlanDoc.parse((JSON.parse(ctx.memory.data.text(obj.content)) as StoredDetailedPlan).plan), latestEffectiveOf<{dplan: string; amendments?: readonly AmendmentEntry[]}>(mine, dplan)?.amendments));
  }
  for (const line of (dplan === undefined ? null : plans.get(dplan))?.tasks.find((t) => t.id === taskId)?.requirementItems ?? []) items.add(line);
  const latest = new Map<string, ItemVersionBody>();
  const byVersion = new Map<string, ItemVersionBody>();
  for (const e of mine) if (e.line === 'requirements' && e.event === 'item') {latest.set((e.body as ItemVersionBody).line, e.body as ItemVersionBody); byVersion.set((e.body as ItemVersionBody).version, e.body as ItemVersionBody);}
  const words = new Set<string>();
  const wordsOf = (s: ItemVersionBody['source'] | undefined): void => {
    if (s?.kind === 'authorization') {items.add(s.line); const a = latest.get(s.line)?.source; if (a?.kind === 'words') words.add(a.words);}
    else if (s?.kind === 'words') words.add(s.words);
  };
  // the version the decision rested on first (its words entry stays named after a revision), then the current one
  const revised: CitedVersion[] = [];
  for (const c of cited) {
    if (c.version === null) continue;
    wordsOf(byVersion.get(c.version)?.source);
    const now = latest.get(c.line);
    if (now?.version !== c.version) revised.push({line: c.line, decided: c.version, current: now?.version ?? null});
  }
  for (const line of [...items]) wordsOf(latest.get(line)?.source);
  return {items: [...items], words: [...words], revised};
}

const clip = (s: string, n: number): string => { const t = s.replace(/\s+/g, ' ').trim(); return t.length <= n ? t : `${t.slice(0, n - 1)}…`; };

function inboxBrief(ctx: ProcessContext, mission: string, mine: readonly FlowRow[], esc: EscalationBody, decided: Decided | undefined, by: string | null, plans: Map<string, DetailedPlanDoc | null>, handedOver: string | null): InboxBrief {
  // the hand-back and the decision event carry the same `authorization` field, and the versions it was decided on: one rule for both
  const auth = typeof decided?.authorization === 'string' ? decided.authorization : null;
  const rest = restsOn(ctx, mine, esc, plans, auth === null ? [] : [{line: auth, version: decided?.inputs?.find((i) => i.line === auth)?.version ?? null}]);
  const shown = esc.reasons.slice(0, 5).map((r) => clip(r, 200));
  return {by, notice: decided?.notice ?? '', reason: decided?.reason ?? '', ...(handedOver !== null ? {handedOver} : {}), options: pmOptions(esc), items: rest.items, words: rest.words, ...(rest.revised.length > 0 ? {revised: rest.revised} : {}), reasons: esc.reasons.length > shown.length ? [...shown, `(${esc.reasons.length - shown.length} more)`] : shown, more: `mp read show escalation ${mission}/${esc.id}`};
}

/** The PM inbox, read in one snapshot of the memory (4.4: its items and their briefs never mix two states). */
export function pmInbox(ctx: ProcessContext): InboxItem[] {
  return ctx.memory.read(() => inboxItems(ctx));
}

function inboxItems(ctx: ProcessContext): InboxItem[] {
  const events = allFlow(ctx);
  const out: InboxItem[] = [];
  const plans = new Map<string, DetailedPlanDoc | null>();
  const is = (mission: string, event: string, key: string) => events.some((e) => e.mission === mission && e.line === 'secretary' && e.event === event && e.key === key);
  const answered = (mission: string, id: string) => {
    if (is(mission, 'applied', id) || is(mission, 'user-answer', id)) return true;
    const round = events.filter((e) => e.mission === mission && e.line === 'secretary' && e.event === 'pm-answer-rejected' && e.key.startsWith(`${id}#`)).length + 1;
    const answer = events.find((e) => e.mission === mission && e.line === 'secretary' && e.event === 'pm-answer' && e.key === `${id}#${round}`);
    return answer !== undefined && (answer.body.words ?? []).every((w: {id: string; fingerprint: string}) => wordsAuthority(ctx.memory, ctx.memory.data, w.id, mission) === w.fingerprint);
  };
  for (const e of events.filter((e) => e.line === 'secretary' && e.event === 'escalation')) {
    const esc = e.body as EscalationBody;
    if (is(e.mission, 'applied', esc.id) || is(e.mission, 'user-answer', esc.id)) continue;
    const pmRound = events.filter((r) => r.mission === e.mission && r.line === 'secretary' && r.event === 'pm-answer-rejected' && r.key.startsWith(`${esc.id}#`)).length + 1;
    const answer = events.find((a) => a.mission === e.mission && a.line === 'secretary' && a.event === 'pm-answer' && a.key === `${esc.id}#${pmRound}`);
    if (answer !== undefined && (answer.body.words ?? []).every((w: {id: string; fingerprint: string}) => wordsAuthority(ctx.memory, ctx.memory.data, w.id, e.mission) === w.fingerprint)) continue;
    const mine = events.filter((r) => r.mission === e.mission);
    const round = secretaryRoundInputs(esc, mine);
    const d = events.find((d) => d.mission === e.mission && d.line === 'secretary' && d.event === 'decision' && d.key === round.key)?.body as DecisionBody | undefined;
    // 4.4 (F9, issue 62): listed from the moment the hand-back is recorded, before a pass writes the decision
    const handed = d === undefined ? handedBackDecision(ctx, round.esc.task) : undefined;
    const decided = d ?? handed;
    const routed = is(e.mission, 'to-user', esc.id) || is(e.mission, 'pm-answer-rejected', `${esc.id}#${pmRound - 1}`) || decided?.classification === 'needs-user' || decided?.classification === 'needs-pm' || answer !== undefined || esc.source === 'plan-structure-change' || esc.source === 'plan-restarts-work';
    if (!routed) continue;
    const id = `${e.mission}/${esc.id}`;
    const asked = is(e.mission, 'asked-user', esc.id);
    out.push({id, kind: 'decision', mission: e.mission, text: `${esc.summary}${esc.source === 'plan-structure-change' && esc.changed ? `\n${esc.changed}` : ''}${pmRound > 1 ? '; the words it rested on changed' : ''}`, state: asked ? 'waits on the user' : 'open', action: `mp pm answer ${e.mission} ${esc.id} --option <option> --by pm|user`, options: esc.options.filter((o) => o !== 'ask-user' && o !== 'ask-pm'), facts: esc.facts, resolution: 'a PM or user answer is recorded', round: pmRound,
      brief: inboxBrief(ctx, e.mission, mine, {...round.esc, id: esc.id}, decided, d?.by ?? (handed !== undefined ? 'secretary' : null), plans, mine.find((t) => t.line === 'secretary' && t.event === 'to-user' && t.key === esc.id)?.body.why ?? null)});
  }
  for (const n of listNotices(ctx.memory, ctx.memory.data, {audience: 'pm'})) {
    const detail = n.detail as {escalation?: string | {id?: string}; escalations?: string[]} | null;
    const id = typeof detail?.escalation === 'string' ? detail.escalation : detail?.escalation?.id;
    const linked = [...new Set([...(id === undefined ? [] : [id]), ...(detail?.escalations ?? [])])];
    if (linked.length > 0 && n.mission !== null && linked.every((id) => answered(n.mission!, id))) continue;
    const pending = linked.filter((id) => n.mission === null || !answered(n.mission, id));
    if (pending.length > 0 && pending.every((id) => out.some((i) => i.id === `${n.mission}/${id}`))) continue;
    // A revised batch resolves a returned first review without an operational PM pass.
    if ((n.category === 'calibrator-1-returned' || n.category === 'calibrator-1-unavailable') && events.some((e) => e.mission === n.mission && e.line === 'plan' && (e.event === 'pm-batch' || e.event === 'cal1-recheck') && e.revision > n.revision)) continue;
    if (n.category === 'mission-complete' && n.mission !== null && (ctx.memory.stmt("SELECT 1 FROM missions WHERE mission = ? AND state = 'closed'").get(n.mission) !== undefined || ctx.memory.stmt("SELECT 1 FROM deliveries WHERE mission = ? AND state = 'recorded'").get(n.mission) !== undefined)) continue;
    const acknowledgeable = linked.length === 0 && PM_NOTICE_ACTIONS[n.category]?.resolvingCommand !== true;
    out.push({id: n.id, kind: 'notice', mission: n.mission, text: n.trigger, state: events.some((e) => e.line === 'resident' && e.event === 'asked-user' && e.key === n.id) ? 'waits on the user' : 'open', acknowledgeable,
      action: pending.length > 0 ? pending.map((id) => `mp pm answer ${n.mission} ${id} --option <option> --by pm|user`).join('; ') : `${n.action ?? 'handle the notice'}${acknowledgeable ? `; mp pm inbox --ack ${n.id}` : ''}`,
      resolution: linked.length > 0 ? 'all linked escalations are answered or applied' : acknowledgeable ? `mp pm inbox --ack ${n.id}` : n.resolution!});
  }
  if (liveSecretary(ctx.memory) !== null) for (const m of ctx.memory.stmt("SELECT mission FROM missions WHERE state = 'open'").all() as {mission: string}[]) {
    const eff = events.filter((e) => e.mission === m.mission && e.line === 'plan' && e.event === 'effective').at(-1);
    if (eff === undefined || !(eff.body.tasks?.length > 0)) continue;
    const allAccepted = (eff.body.tasks as string[]).every((task) => events.filter((e) => e.mission === m.mission && e.line === `task:${task}` && ['accepted','abandoned','attempt','reopened','rework'].includes(e.event)).at(-1)?.event === 'accepted');
    const openDecision = events.some((e) => e.mission === m.mission && e.line === 'secretary' && e.event === 'escalation' && !is(m.mission, 'applied', e.key));
    if (!allAccepted || openDecision || ctx.memory.stmt("SELECT 1 FROM deliveries WHERE mission = ? AND state = 'recorded'").get(m.mission) !== undefined) continue;
    const id = `mission-end:${m.mission}:${eff.body.dplan}`;
    if (!events.some((e) => e.line === 'resident' && e.event === 'inbox-ack' && e.key === id)) out.push({id, kind: 'notice', mission: m.mission, text: `mission ${m.mission}: all tasks in ${eff.body.dplan} are accepted`, state: 'open', action: 'report to the user and ask consent to deliver', resolution: 'delivery is recorded or the mission is closed'});
  }
  const acked = new Set(events.filter((e) => e.line === 'resident' && e.event === 'inbox-ack').map((e) => e.key));
  const replied = new Set(residentRecords(ctx.memory, 'sec.reply').map((r) => r.id));
  for (const q of residentRecords(ctx.memory, 'pm.question')) if (!replied.has(q.id)) out.push({id: q.id, kind: 'question', mission: null, text: q.text, state: 'open', action: 'wait for the Secretary’s reply', resolution: 'the Secretary records a reply'});
  for (const r of residentRecords(ctx.memory, 'sec.reply')) if (!acked.has(r.id)) out.push({id: r.id, kind: 'reply', mission: null, text: r.text, state: 'answered', action: 'answer the user’s progress question', resolution: `mp pm inbox --ack ${r.id}`});
  const pmReplied = new Set(residentRecords(ctx.memory, 'pm.reply').map((r) => r.id));
  for (const q of residentRecords(ctx.memory, 'sec.question')) if (!pmReplied.has(q.id)) out.push({id: q.id, kind: 'question', mission: null, text: q.text, about: q.about, state: events.some((e) => e.line === 'resident' && e.event === 'asked-user' && e.key === q.id) ? 'waits on the user' : 'open', action: `mp pm reply ${q.id} "<answer>" [--words W-n]`, resolution: 'the PM records a reply'});
  return out;
}

export function markInbox(ctx: ProcessContext, o: {op: string; id: string; asked?: boolean}): void {
  requirePm(ctx.secretary);
  ctx.memory.write({op: `inbox:${o.op}`, payload: o, command: 'inbox', filler: ctx.filler}, (tx) => {
    const item = pmInbox(ctx).find((i) => i.id === o.id || (i.kind === 'decision' && i.id.endsWith(`/${o.id}`)));
    if (item === undefined) notAllowed(`no pending PM inbox item ${o.id}`);
    if (o.asked === true) {
      if (item.kind === 'notice' || (item.kind === 'question' && residentRecords(tx, 'sec.question').some((q) => q.id === item.id))) {
        const mission = (item.mission ?? 'project') as MissionId;
        if (!flowEvents(tx, {mission, line: 'resident', event: 'asked-user', limit: 10_000}).some((e) => e.key === item.id)) appendRecords(tx, [{kind: 'flow.event', mission, line: 'resident', event: 'asked-user', key: item.id, body: tx.data.put(canonicalJson({id: item.id})) as ContentHash}]);
        return;
      }
      if (item.kind !== 'decision' || item.mission === null) notAllowed('--asked-user names an unresolved decision or PM notice');
      const key = item.id.slice(item.mission.length + 1);
      if (flowEvents(tx, {mission: item.mission as MissionId, line: 'secretary', event: 'asked-user', limit: 10_000}).some((e) => e.key === key)) return;
      appendRecords(tx, [{kind: 'flow.event', mission: item.mission as MissionId, line: 'secretary', event: 'asked-user', key, body: tx.data.put(canonicalJson({id: item.id, round: item.round})) as ContentHash}]);
    } else if (item.kind === 'notice') {if (item.acknowledgeable !== true) notAllowed(`${item.id} resolves when ${item.resolution}; take the named PM action`); markNoticesInTx(tx, item.id);}
    else if (item.kind === 'reply') appendRecords(tx, [{kind: 'flow.event', mission: 'project' as MissionId, line: 'resident', event: 'inbox-ack', key: item.id, body: tx.data.put('{}') as ContentHash}]);
    else notAllowed(item.kind === 'question' ? `this question resolves when ${item.resolution}; ${item.action}` : 'a decision resolves through mp pm answer');
  });
}

// Avoid a nested write when acknowledging an inbox notice.
import { markNotice } from '../memory/domain/pm.ts';
import type { WriteTx } from '../memory/memory.ts';
function markNoticesInTx(tx: WriteTx, id: string): void {markNotice(tx, {notice: id, state: 'acknowledged'});}

export interface SecretaryNext extends NextReport {stops: ReturnType<typeof activeStops>; revision: number; unconfirmed: ReturnType<typeof unconfirmedSeats>; notes: ReturnType<typeof channel>['notes']; questions: ReturnType<typeof channel>['questions']; replies: ReturnType<typeof channel>['replies']; decisions: unknown[]}
export async function secNext(ctx: ProcessContext): Promise<SecretaryNext> {
  requireSecretary(ctx.memory, ctx.secretary);
  touchSecretary(ctx.memory, ctx.secretary);
  const r = await pmNext(ctx);
  const decisions = allFlow(ctx).filter((e) => e.line === 'secretary' && e.event === 'applied' && (e.body.by === 'pm' || e.body.by === 'user'));
  return {...r, stops: activeStops(ctx.memory), waitingOnUser: r.waitingOnUser.filter((w) => pmInbox(ctx).some((i) => i.id === `${w.mission}/${w.escalation}` && i.state === 'waits on the user')), ...channel(ctx), decisions, unconfirmed: unconfirmedSeats(ctx.memory), revision: Number(ctx.memory.head())};
}

/** Business revisions exclude our own action receipts, delivery marks and generation heartbeat. */
export function actionableRevision(db: Db): number {
  return Number((db.stmt("SELECT COALESCE(MAX(rev), 0) AS rev FROM log WHERE kind NOT IN ('pm.action','op.receipt','secretary.generation','cursor.set','leaf.recorded','notice.delivery')").get() as {rev: number}).rev);
}

export async function secWait(ctx: ProcessContext, o: {since: number; timeout?: number; pollMs?: number; periodicMs?: number}): Promise<{revision: number; timedOut: boolean; unconfirmed: ReturnType<typeof unconfirmedSeats>; replies: ReturnType<typeof channel>['replies']}> {
  requireSecretary(ctx.memory, ctx.secretary);
  const deadline = Date.now() + (o.timeout ?? 300) * 1000;
  let nextCheck = 0;
  while (true) {
    requireSecretary(ctx.memory, ctx.secretary);
    if (Date.now() >= nextCheck) {await secNext(ctx); nextCheck = Date.now() + (o.periodicMs ?? 30_000);}
    const unconfirmed = unconfirmedSeats(ctx.memory);
    if (unconfirmed.length > 0 || actionableRevision(ctx.memory) > o.since) return {revision: Number(ctx.memory.head()), timedOut: false, unconfirmed, replies: channel(ctx).replies};
    if (Date.now() >= deadline) return {revision: Number(ctx.memory.head()), timedOut: true, unconfirmed, replies: channel(ctx).replies};
    await new Promise((resolve) => setTimeout(resolve, Math.min(o.pollMs ?? 100, Math.max(1, deadline - Date.now()))));
  }
}

export function currentSecretaryRound(ctx: ProcessContext, id: string) {
  const events = allFlow(ctx);
  const matches = events.filter((e) => e.line === 'secretary' && e.event === 'escalation' && e.key === id && !events.some((a) => a.mission === e.mission && a.line === 'secretary' && a.event === 'applied' && a.key === id));
  if (matches.length !== 1) notAllowed(`${id} must name exactly one open escalation (found ${matches.length})`);
  const e = matches[0]!;
  return {mission: e.mission, ...secretaryRoundInputs(e.body as EscalationBody, events.filter((r) => r.mission === e.mission))};
}

export async function secCard(ctx: ProcessContext, id: string): Promise<Dispatched> {
  const g = requireSecretary(ctx.memory, ctx.secretary);
  const round = currentSecretaryRound(ctx, id);
  const task = round.esc.task;
  const existing = listDispatches(ctx.memory, {task, limit: 10_000}).find((d) => d.state === 'in-flight');
  if (existing !== undefined) {
    const claimed = allFlow(ctx).find((e) => e.line === `dispatch:${existing.dispatch}` && e.event === 'claimed' && e.key === 'spec');
    if (claimed?.body.generation !== g.generation) notAllowed(`${existing.dispatch} belongs to an earlier generation; release it --ended before claiming the current round`);
    const v = seatCard(ctx, existing.dispatch);
    return {dispatch: existing.dispatch, step: task, seat: 'secretary', kind: 'secretary', mission: round.mission, card: v.text, cardLeaf: existing.cardLeaf ?? '', worktree: null, files: handBackFiles(existing.dispatch), prompt: '', size: cardSizeReport(ctx, dispatchView(ctx, existing.dispatch).card)};
  }
  // 4.4 (F5): a command-line claim takes the checked path (repair starts checked first); this one prints the card to the Secretary, so it is served
  const d = await pmDispatchChecked(ctx, task, {filledBy: g.filler});
  recordServed(ctx, d);
  return d;
}

export function secDecisionDispatch(ctx: ProcessContext, id: string): string {
  const g = requireSecretary(ctx.memory, ctx.secretary);
  const round = currentSecretaryRound(ctx, id);
  const d = listDispatches(ctx.memory, {task: round.esc.task, limit: 10_000}).find((d) => d.state === 'in-flight');
  if (d === undefined) notAllowed(`claim the current round first: mp sec card ${id}`);
  const claimed = allFlow(ctx).find((e) => e.line === `dispatch:${d.dispatch}` && e.event === 'claimed' && e.key === 'spec');
  if (claimed?.body.generation !== g.generation) notAllowed(`release ${d.dispatch} --ended; its claim belongs to an earlier generation`);
  return d.dispatch;
}

export async function secDecide(ctx: ProcessContext, id: string, result: SecretaryResult) {
  const dispatch = secDecisionDispatch(ctx, id);
  const path = join(ctx.memory.paths.tmp, dispatch);
  mkdirSync(path, {recursive: true});
  writeFileSync(join(path, 'report.md'), `${result.reason}\n`);
  writeFileSync(join(path, 'result.json'), JSON.stringify(result));
  // 4.4 (F9): the hand-back runs the flow step itself (seat.ts advanceQuietly), as the seat way does under this identity
  return seatHandback(ctx, dispatch, {report: `.mission-pipeline/tmp/${dispatch}/report.md`, result: `.mission-pipeline/tmp/${dispatch}/result.json`, filler: ctx.filler});
}

/** The F-3 gap default stays visible until the mission ends or the answer is rejected. */
export function pmDecisionsWithoutWords(ctx: ProcessContext): {mission: string; escalation: string; reason: string; applied: boolean}[] {
  const events = allFlow(ctx);
  return events.filter((e) => e.line === 'secretary' && e.event === 'pm-answer' && e.body.noWords === true && !events.some((a) => a.mission === e.mission && a.line === 'secretary' && a.event === 'user-answer' && a.key === e.body.escalation) && !events.some((r) => r.mission === e.mission && r.line === 'secretary' && r.event === 'pm-answer-rejected' && r.key === e.key) && ctx.memory.stmt("SELECT 1 FROM missions WHERE mission = ? AND state = 'open'").get(e.mission) !== undefined).map((e) => ({mission: e.mission, escalation: e.body.escalation as string, reason: e.body.reason as string, applied: events.some((r) => r.mission === e.mission && r.line === 'secretary' && r.event === 'applied' && r.key === e.body.escalation && r.body.by === 'pm')}));
}
