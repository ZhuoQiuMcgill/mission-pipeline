import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { MissionId, ContentHash } from '../common/ids.ts';
import { canonicalJson } from '../common/hash.ts';
import { activeStops, appendRecords, dispatchInfo, wordsEntry, flowEvents, listDispatches, type Db } from '../memory/index.ts';
import { generations, liveSecretary, notAllowed, requireSecretary, requirePm, touchSecretary, writeGeneration } from '../memory/resident.ts';
import { residentRecords, wordsAuthority } from '../memory/words.ts';
import { stopCovers } from '../memory/stopTypes.ts';
import type { ProcessContext } from './context.ts';
import { advance } from './advance.ts';
import { pmDispatch, pmNext, type Dispatched, type NextReport } from './pm.ts';
import { dispatchView, seatCard, seatHandback } from './seat.ts';
import { listNotices, markNotices } from './notices.ts';
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

export function channel(ctx: ProcessContext): {notes: {id: string; text: string; words: string | null}[]; questions: {id: string; text: string}[]} {
  const notes = new Map(residentRecords(ctx.memory, 'pm.note').map((n) => [n.id, n]));
  const replied = new Set(residentRecords(ctx.memory, 'sec.reply').map((r) => r.id));
  return {notes: [...notes.values()].filter((n) => !n.acknowledged), questions: residentRecords(ctx.memory, 'pm.question').filter((q) => !replied.has(q.id))};
}

export function pmNote(ctx: ProcessContext, o: {op: string; text: string; words?: string | null}): string {
  requirePm(ctx.secretary);
  return ctx.memory.write({op: `note:${o.op}`, payload: o, command: 'note', filler: ctx.filler}, (tx) => {
    if (o.text.trim() === '') notAllowed('a note needs text');
    if (o.words != null && wordsEntry(tx, o.words) === null) notAllowed(`no words entry ${o.words}`);
    const id = `N-${new Set(residentRecords(tx, 'pm.note').map((n) => n.id)).size + 1}`;
    tx.append({kind: 'pm.note', id, text: o.text, words: o.words ?? null, acknowledged: false}); return id;
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

export function secAckNote(ctx: ProcessContext, o: {op: string; id: string}): void {
  ctx.memory.write({op: `ack-note:${o.op}`, payload: o, command: 'sec ack-note', filler: ctx.filler}, (tx) => {
    requireSecretary(tx, ctx.secretary);
    const n = residentRecords(tx, 'pm.note').filter((n) => n.id === o.id).at(-1);
    if (n === undefined) notAllowed(`no PM note ${o.id}`);
    if (!n.acknowledged) tx.append({...n, acknowledged: true});
  });
}

export interface InboxItem {id: string; kind: 'decision' | 'notice' | 'question' | 'reply'; mission: string | null; text: string; state: string; action: string; resolution: string; round?: number; options?: readonly string[]; facts?: unknown}
function allFlow(ctx: ProcessContext) {
  return (ctx.memory.stmt('SELECT mission, line, event, key, body, revision AS rev FROM flow_events ORDER BY revision').all() as {mission: string; line: string; event: string; key: string; body: string; rev: number}[]).map((e) => ({...e, revision: Number(e.rev), mission: e.mission as MissionId, body: JSON.parse(ctx.memory.data.text(e.body)) as any}));
}

export function pmInbox(ctx: ProcessContext): InboxItem[] {
  const events = allFlow(ctx);
  const out: InboxItem[] = [];
  const is = (mission: string, event: string, key: string) => events.some((e) => e.mission === mission && e.line === 'secretary' && e.event === event && e.key === key);
  for (const e of events.filter((e) => e.line === 'secretary' && e.event === 'escalation')) {
    const esc = e.body as EscalationBody;
    if (is(e.mission, 'applied', esc.id) || is(e.mission, 'user-answer', esc.id)) continue;
    const pmRound = events.filter((r) => r.mission === e.mission && r.line === 'secretary' && r.event === 'pm-answer-rejected' && r.key.startsWith(`${esc.id}#`)).length + 1;
    const answer = events.find((a) => a.mission === e.mission && a.line === 'secretary' && a.event === 'pm-answer' && a.key === `${esc.id}#${pmRound}`);
    if (answer !== undefined && (answer.body.words ?? []).every((w: {id: string; fingerprint: string}) => wordsAuthority(ctx.memory, ctx.memory.data, w.id, e.mission) === w.fingerprint)) continue;
    const round = secretaryRoundInputs(esc, events.filter((r) => r.mission === e.mission));
    const d = events.find((d) => d.mission === e.mission && d.line === 'secretary' && d.event === 'decision' && d.key === round.key)?.body as DecisionBody | undefined;
    const routed = is(e.mission, 'to-user', esc.id) || is(e.mission, 'pm-answer-rejected', `${esc.id}#${pmRound - 1}`) || d?.classification === 'needs-user' || d?.classification === 'needs-pm' || answer !== undefined || esc.source === 'plan-structure-change' || esc.source === 'plan-restarts-work';
    if (!routed) continue;
    const id = `${e.mission}/${esc.id}`;
    const asked = is(e.mission, 'asked-user', esc.id);
    out.push({id, kind: 'decision', mission: e.mission, text: `${esc.summary}${esc.source === 'plan-structure-change' && esc.changed ? `\n${esc.changed}` : ''}${pmRound > 1 ? '; the words it rested on changed' : ''}`, state: asked ? 'waits on the user' : 'open', action: `mp pm answer ${e.mission} ${esc.id} --option <option> --by pm|user`, options: esc.options.filter((o) => o !== 'ask-user' && o !== 'ask-pm'), facts: esc.facts, resolution: 'a PM or user answer is recorded', round: pmRound});
  }
  for (const n of listNotices(ctx.memory, ctx.memory.data, {audience: 'pm'})) {
    const detail = n.detail as {escalation?: string | {id?: string}} | null;
    const id = typeof detail?.escalation === 'string' ? detail.escalation : detail?.escalation?.id;
    if (id !== undefined && n.mission !== null && (is(n.mission, 'applied', id) || is(n.mission, 'user-answer', id) || events.some((e) => e.mission === n.mission && e.event === 'pm-answer' && e.key.startsWith(`${id}#`) && !is(n.mission!, 'pm-answer-rejected', e.key)))) continue;
    if (id !== undefined && out.some((i) => i.id === `${n.mission}/${id}`)) continue;
    // A revised batch resolves a returned first review without an operational PM pass.
    if ((n.category === 'calibrator-1-returned' || n.category === 'calibrator-1-unavailable') && events.some((e) => e.mission === n.mission && e.line === 'plan' && (e.event === 'pm-batch' || e.event === 'cal1-recheck') && e.revision > n.revision)) continue;
    out.push({id: n.id, kind: 'notice', mission: n.mission, text: n.trigger, state: events.some((e) => e.line === 'resident' && e.event === 'asked-user' && e.key === n.id) ? 'waits on the user' : 'open', action: n.action ?? 'decide the routed question', resolution: n.resolution ?? 'the PM acknowledges the notice'});
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
  return out;
}

export function markInbox(ctx: ProcessContext, o: {op: string; id: string; asked?: boolean}): void {
  requirePm(ctx.secretary);
  ctx.memory.write({op: `inbox:${o.op}`, payload: o, command: 'inbox', filler: ctx.filler}, (tx) => {
    const item = pmInbox(ctx).find((i) => i.id === o.id || (i.kind === 'decision' && i.id.endsWith(`/${o.id}`)));
    if (item === undefined) notAllowed(`no pending PM inbox item ${o.id}`);
    if (o.asked === true) {
      if (item.kind === 'notice') {
        const mission = (item.mission ?? 'project') as MissionId;
        if (!flowEvents(tx, {mission, line: 'resident', event: 'asked-user', limit: 10_000}).some((e) => e.key === item.id)) appendRecords(tx, [{kind: 'flow.event', mission, line: 'resident', event: 'asked-user', key: item.id, body: tx.data.put(canonicalJson({id: item.id})) as ContentHash}]);
        return;
      }
      if (item.kind !== 'decision' || item.mission === null) notAllowed('--asked-user names an unresolved decision or PM notice');
      const key = item.id.slice(item.mission.length + 1);
      if (flowEvents(tx, {mission: item.mission as MissionId, line: 'secretary', event: 'asked-user', limit: 10_000}).some((e) => e.key === key)) return;
      appendRecords(tx, [{kind: 'flow.event', mission: item.mission as MissionId, line: 'secretary', event: 'asked-user', key, body: tx.data.put(canonicalJson({id: item.id, round: item.round})) as ContentHash}]);
    } else if (item.kind === 'notice') {if (!item.resolution.includes('acknowledges')) notAllowed(`${item.id} resolves when ${item.resolution}; take the named PM action`); markNoticesInTx(tx, item.id);}
    else if (item.kind === 'reply') appendRecords(tx, [{kind: 'flow.event', mission: 'project' as MissionId, line: 'resident', event: 'inbox-ack', key: item.id, body: tx.data.put('{}') as ContentHash}]);
    else notAllowed(item.kind === 'question' ? 'this question waits for the Secretary’s reply' : 'a decision resolves through mp pm answer');
  });
}

// Avoid a nested write when acknowledging an inbox notice.
import { markNotice } from '../memory/domain/pm.ts';
import type { WriteTx } from '../memory/memory.ts';
function markNoticesInTx(tx: WriteTx, id: string): void {markNotice(tx, {notice: id, state: 'acknowledged'});}

export interface SecretaryNext extends NextReport {stops: ReturnType<typeof activeStops>; revision: number; unconfirmed: ReturnType<typeof unconfirmedSeats>; notes: ReturnType<typeof channel>['notes']; questions: ReturnType<typeof channel>['questions']; decisions: unknown[]}
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

export async function secWait(ctx: ProcessContext, o: {since: number; timeout?: number; pollMs?: number; periodicMs?: number}): Promise<{revision: number; timedOut: boolean; unconfirmed: ReturnType<typeof unconfirmedSeats>}> {
  requireSecretary(ctx.memory, ctx.secretary);
  const deadline = Date.now() + (o.timeout ?? 300) * 1000;
  let nextCheck = 0;
  while (true) {
    requireSecretary(ctx.memory, ctx.secretary);
    if (Date.now() >= nextCheck) {await secNext(ctx); nextCheck = Date.now() + (o.periodicMs ?? 30_000);}
    const unconfirmed = unconfirmedSeats(ctx.memory);
    if (unconfirmed.length > 0 || actionableRevision(ctx.memory) > o.since) return {revision: Number(ctx.memory.head()), timedOut: false, unconfirmed};
    if (Date.now() >= deadline) return {revision: Number(ctx.memory.head()), timedOut: true, unconfirmed};
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

export function secCard(ctx: ProcessContext, id: string): Dispatched {
  const g = requireSecretary(ctx.memory, ctx.secretary);
  const round = currentSecretaryRound(ctx, id);
  const task = round.esc.task;
  const existing = listDispatches(ctx.memory, {task, limit: 10_000}).find((d) => d.state === 'in-flight');
  if (existing !== undefined) {
    const claimed = allFlow(ctx).find((e) => e.line === `dispatch:${existing.dispatch}` && e.event === 'claimed' && e.key === 'spec');
    if (claimed?.body.generation !== g.generation) notAllowed(`${existing.dispatch} belongs to an earlier generation; release it --ended before claiming the current round`);
    const v = seatCard(ctx, existing.dispatch);
    return {dispatch: existing.dispatch, step: task, seat: 'secretary', kind: 'secretary', mission: round.mission, card: v.text, cardLeaf: existing.cardLeaf ?? '', worktree: null, files: handBackFiles(existing.dispatch), prompt: ''};
  }
  return pmDispatch(ctx, task, {filledBy: g.filler});
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
  const handback = await seatHandback(ctx, dispatch, {report: `.mission-pipeline/tmp/${dispatch}/report.md`, result: `.mission-pipeline/tmp/${dispatch}/result.json`, filler: ctx.filler});
  if (handback.kind === 'recorded') await advance(ctx, currentSecretaryRound(ctx, id).mission);
  return handback;
}

/** The F-3 gap default stays visible until the mission ends or the answer is rejected. */
export function pmDecisionsWithoutWords(ctx: ProcessContext): {mission: string; escalation: string; reason: string; applied: boolean}[] {
  const events = allFlow(ctx);
  return events.filter((e) => e.line === 'secretary' && e.event === 'pm-answer' && e.body.noWords === true && !events.some((a) => a.mission === e.mission && a.line === 'secretary' && a.event === 'user-answer' && a.key === e.body.escalation) && !events.some((r) => r.mission === e.mission && r.line === 'secretary' && r.event === 'pm-answer-rejected' && r.key === e.key) && ctx.memory.stmt("SELECT 1 FROM missions WHERE mission = ? AND state = 'open'").get(e.mission) !== undefined).map((e) => ({mission: e.mission, escalation: e.body.escalation as string, reason: e.body.reason as string, applied: events.some((r) => r.mission === e.mission && r.line === 'secretary' && r.event === 'applied' && r.key === e.body.escalation && r.body.by === 'pm')}));
}
