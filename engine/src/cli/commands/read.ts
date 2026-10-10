// Layered reads (design 10.2): `status` is layer 0; `show <kind> <id>` gives layer 1 (state,
// last change, one line of blocking reason and next step) and layer 2 (the base records);
// `alerts` lists the notices for the PM with their WI numbers, the trigger facts, the default
// action already taken and the WI's page (3.9, 3.11); `ops` lists the PM's recorded actions.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { LOOP_KINDS } from '../../common/records.ts';
import type { ActiveStop, DispatchedTask, LaunchInfo, QueuedTask, TaskInfo } from '../../ledger/queries.ts';
import { readStopHistory, stopCovers, stopDeliveryStates } from '../../ledger/stops.ts';
import { ControlPlane } from '../../scheduler/controlPlane.ts';
import { readCheckpointSummary, faultTimeView } from '../../evaluator/checkpoint.ts';
import { flagBool, flagList, positional } from '../args.ts';
import type { Command } from '../command.ts';
import { ok } from '../command.ts';
import { ledgerPathsOf, stopPathsOf } from '../config.ts';
import type { Ctx } from '../context.ts';
import { CliError, EXIT, usage } from '../errors.ts';
import { collectLayer0, deliveryStateEn, renderLayer0 } from '../layer0.ts';
import { Layer2Reader, deliveriesOf, findDelivery } from '../layer2.ts';
import { listNotices, markAcknowledged, markDelivered, syncNotices, type PmNotice } from '../notices.ts';
import { describeScope } from '../stopDetect.ts';
import { wiPagePath, wiRef, wiTitle } from '../wi.ts';
import { deliveryLandingState } from '../adapters/delivery.ts';

const time = (ms: number | null | undefined): string => (ms === null || ms === undefined ? '-' : `${new Date(ms).toISOString().replace('T', ' ').slice(0, 19)} UTC`);

export const statusCmd: Command = {
  name: 'status',
  summary: 'layer 0: stops in their four states, the recovery pause, the evaluator, notices (with WI numbers), blocks, spend, landings',
  usage: 'mp status',
  flags: {},
  changesState: false,
  async run(ctx) {
    const l = await collectLayer0(ctx, { markAsked: true });
    return ok(renderLayer0(l), l);
  },
};

function noticeSources(ctx: Ctx) {
  return { controlPlane: ctx.config.controlPlane, stateDir: ctx.config.stateDir, dbPath: ledgerPathsOf(ctx.config).db, content: ctx.content() };
}

/** The ledger's delivery states first (another session may have shown or acknowledged them); the local marks when it is down. */
async function syncedNotices(ctx: Ctx): Promise<PmNotice[]> {
  const src = noticeSources(ctx);
  await syncNotices(ctx.ledger(2_000), ctx.config.stateDir, listNotices(src).map((n) => n.id));
  return listNotices(src);
}

export function renderNotice(n: PmNotice, env: NodeJS.ProcessEnv = process.env): string[] {
  const title = wiTitle(n.wi, env);
  const ref = wiRef(n.wi, env);
  const lines = [`[${n.state}] ${n.id}${n.wi !== null ? ` ${n.wi}${title !== null ? ` ${title}` : ''}` : ''} (${n.category}, ${time(n.at)}${n.committed ? '' : ', not committed to the ledger yet'})`];
  if (n.trigger !== '') lines.push(`  Trigger: ${n.trigger.slice(0, 400)}`);
  if (n.defaultAction !== null) lines.push(`  Default action already taken: ${n.defaultAction.slice(0, 400)}`);
  if (ref !== null) lines.push(`  Handle per ${n.wi}: open the WI page ${wiPagePath(n.wi, env)}`);
  return lines;
}

export const alertsCmd: Command = {
  name: 'alerts',
  summary: 'notices for the PM: WI number, trigger facts, the default action already taken, and the WI page',
  usage: 'mp alerts [--all] [--ack <notice id,...>]',
  flags: { all: 'boolean', ack: 'list' },
  changesState: false,
  async run(ctx, args) {
    const ack = flagList(args, 'ack');
    if (ack.length > 0) {
      markAcknowledged(ctx.config.stateDir, ack, ctx.now);
      const recorded = await syncNotices(ctx.ledger(2_000), ctx.config.stateDir, ack);
      return ok(`Acknowledged ${ack.length} notice(s): ${ack.join(', ')}${recorded ? '' : ' (the ledger did not answer; recorded locally and sent later)'}`, { acknowledged: ack, recorded });
    }
    const all = await syncedNotices(ctx);
    const shown = flagBool(args, 'all') ? all : all.filter((n) => n.state !== 'acknowledged');
    markDelivered(ctx.config.stateDir, shown.map((n) => n.id), ctx.now);
    await syncNotices(ctx.ledger(2_000), ctx.config.stateDir);
    if (shown.length === 0) return ok('No notices to handle.', { notices: [] });
    const lines = [`Notices (${shown.length}):`];
    for (const n of shown) lines.push(...renderNotice(n, ctx.io.env));
    lines.push('After handling them or telling the user: mp alerts --ack <notice id>');
    return ok(lines.join('\n'), { notices: shown.map((n) => ({ ...n, state: n.state === 'undelivered' ? 'delivered' : n.state, page: wiPagePath(n.wi, ctx.io.env) })) });
  },
};

// ---------------------------------------------------------------- show

async function showStop(ctx: Ctx, stop: string): Promise<{ text: string; json: unknown }> {
  const cp = new ControlPlane(ctx.config.controlPlane);
  const ledgerState = await ctx.tryCall('stopState', { stop });
  const active = await ctx.tryCall('activeStops', {});
  const committed = active.ok ? ((active.value as ActiveStop[]).find((s) => s.stop === stop) ?? null) : null;
  const sent = stopDeliveryStates(ctx.config.controlPlane).find((s) => s.stop === stop) ?? null;
  const sentState = sent === null ? null : deliveryStateEn(sent.state);
  const history = readStopHistory(stopPathsOf(ctx.config)).find((r) => r.stop === stop) ?? null;
  const report = cp.stopReport(stop as never);
  const state = !ledgerState.ok
    ? (sentState ?? 'unknown (the ledger service is unavailable)')
    : ledgerState.value === 'released'
      ? 'released'
      : ledgerState.value === 'active'
        ? report?.state === 'stopped'
          ? 'stopped'
          : report?.state === 'stop-effective-unkillable'
            ? 'committed, processes cannot be ended (WI-14)'
            : 'committed'
        : (sentState ?? (history !== null ? 'persisted, awaiting commit' : 'no such stop'));
  const scope = committed?.scope ?? history?.scope ?? null;
  const lines = [`Stop ${stop}: ${state}`, `Scope: ${scope === null ? 'unknown' : describeScope(scope)}`, `Words: ${committed?.words ?? history?.words ?? '-'}`];
  if (committed !== null) lines.push(`Requested ${time(committed.requestedAt)}, committed ${time(committed.committedAt)}`);
  if (report !== null) {
    lines.push(`Stop report: ${report.summary}`);
    for (const u of report.unkillable) lines.push(`  Cannot be ended: pid ${u.pid} (${u.what}): ${u.reason}`);
    for (const i of report.undeterminedActions) lines.push(`  Started before the stop, outcome undetermined: ${i.kind} ${i.intent} (${i.state}) ${i.note}`);
  }
  return { text: lines.join('\n'), json: { stop, state, scope, committed, sent: sent === null ? null : { ...sent, state: sentState }, inbox: history, report } };
}

/**
 * ", model: configured X, served Y" for a seat launch whose outcome (seat/host.ts, in the
 * scheduler's state directory) lists served models other than the configured one; else "".
 */
export function servedModelNote(stateDir: string, launch: string): string {
  try {
    const o = JSON.parse(readFileSync(join(stateDir, 'units', launch, 'outcome.json'), 'utf8')) as { format?: unknown; model?: { name?: unknown } | null; served?: unknown };
    const configured = o.model?.name;
    const served = Array.isArray(o.served) ? o.served.filter((x): x is string => typeof x === 'string') : [];
    if (o.format !== 'mp4.seat-host-outcome.v1' || typeof configured !== 'string' || served.length === 0 || served.every((m) => m === configured)) return '';
    return `, model: configured ${configured}, served ${served.join(', ')}`;
  } catch {
    return '';
  }
}

async function showTask(ctx: Ctx, task: string): Promise<{ text: string; json: unknown }> {
  const info = (await ctx.call('taskInfo', { task })) as TaskInfo | null;
  let view: { state: string; note: string | null; launches: string[] } | null = null;
  try {
    const all = (await ctx.sched('tasks', {})) as Array<{ task: string; state: string; note: string | null; launches: string[] }>;
    view = all.find((t) => t.task === task) ?? null;
  } catch {
    view = null;
  }
  if (info === null && view === null) throw new CliError('NOT_FOUND', `no task ${task}`, { exitCode: EXIT.REFUSED });
  const launches: LaunchInfo[] = [];
  for (const l of view?.launches ?? (info?.launch ? [info.launch] : [])) {
    const r = await ctx.tryCall('launches', { launch: l as never });
    if (r.ok) launches.push(...(r.value as LaunchInfo[]));
  }
  const loops: Array<{ loop: string; attempts: number; allowed: number; exhausted: boolean; reason: string | null }> = [];
  if (info !== null) {
    for (const loop of LOOP_KINDS) {
      const r = await ctx.tryCall('loopState', { lineage: info.lineage, loop });
      if (r.ok) {
        const s = r.value as { attempts: number; allowed: number; exhausted: boolean; reason: string | null };
        if (s.attempts > 0 || s.exhausted) loops.push({ loop, attempts: s.attempts, allowed: s.allowed, exhausted: s.exhausted, reason: s.reason });
      }
    }
  }
  const lines = [`Task ${task}: ${view?.state ?? info?.state ?? '-'} (mission ${info?.mission ?? '-'}, lineage ${info?.lineage ?? '-'})`, `Last change: ${time(info?.updatedAt)}`];
  if (view?.note) lines.push(`Blocking reason and next step: ${view.note}`);
  for (const l of launches) lines.push(`  Launch ${l.launch}: ${l.disposition ?? 'running'}, cleanup ${l.cleanup ?? '-'}, started ${time(l.createdAt)}${servedModelNote(ctx.config.stateDir, l.launch)}`);
  for (const l of loops) lines.push(`  Loop ${l.loop}: ${l.attempts}/${l.allowed}${l.exhausted ? `, exhausted (${l.reason}, WI-08)` : ''}`);
  return { text: lines.join('\n'), json: { task, info, scheduler: view, launches, loops } };
}

async function showMission(ctx: Ctx, mission: string): Promise<{ text: string; json: unknown }> {
  const [queue, dispatched, launches, blocks, spend, stops] = await Promise.all([
    ctx.call('taskQueue', { mission }) as Promise<QueuedTask[]>,
    ctx.call('dispatchedTasks', { mission, disposed: false }) as Promise<DispatchedTask[]>,
    ctx.call('launches', { scope: { kind: 'mission', mission: mission as never } }) as Promise<LaunchInfo[]>,
    ctx.call('missionBlocks', { mission }) as Promise<Array<{ record: { reason: string; state: string } }>>,
    ctx.call('spendSummary', { mission }) as Promise<{ limit: number | null; spent: number; inflight: number }>,
    ctx.call('activeStops', {}) as Promise<ActiveStop[]>,
  ]);
  const reader = Layer2Reader.open(ledgerPathsOf(ctx.config).db);
  const deliveries = reader === null ? [] : deliveriesOf(reader, mission);
  reader?.close();
  const covering = stops.filter((s) => stopCovers(s.scope, { mission: mission as never, capabilities: [] }) || s.scope.kind === 'capability');
  const running = launches.filter((l) => l.disposition === null);
  const usd = (m: number | null): string => (m === null ? 'unlimited' : `$${(m / 1e6).toFixed(2)}`);
  const lines = [`Mission ${mission}: queued ${queue.length}, running ${running.length}, dispatched without disposition ${dispatched.length}`, `Spend: spent ${usd(spend.spent)}, in flight ${usd(spend.inflight)}, limit ${usd(spend.limit)}`];
  for (const b of blocks) if (b.record.state === 'blocked') lines.push(`Blocked: ${b.record.reason === 'budget' ? 'budget (WI-09)' : 'resources (WI-10)'}`);
  for (const s of covering) lines.push(`Stop ${s.stop} (${describeScope(s.scope)}): ${s.words.slice(0, 60)}`);
  for (const q of queue) lines.push(`  Queued: ${q.task} (lineage ${q.lineage}, ${time(q.queuedAt)})`);
  for (const d of dispatched) lines.push(`  Dispatched: ${d.task} -> ${d.launch}`);
  for (const d of deliveries) lines.push(`  Delivery ${d.record.delivery}: commit ${d.record.commit.slice(0, 12)}, base ${d.record.base.slice(0, 12)}, ref ${d.record.ref}`);
  return { text: lines.join('\n'), json: { mission, queue, dispatched, launches, blocks, spend, stops: covering, deliveries } };
}

function showFact(ctx: Ctx, kind: 'basis.version' | 'object.version', id: string, label: string): { text: string; json: unknown } {
  const reader = Layer2Reader.open(ledgerPathsOf(ctx.config).db);
  if (reader === null) throw new CliError('UNAVAILABLE', 'cannot read the main ledger (read-only)', { exitCode: EXIT.UNAVAILABLE });
  try {
    let rec: { revision: number; committedAt: number; record: unknown } | null = reader.fact(kind, id);
    let versions: number[] = [];
    if (rec === null && kind === 'basis.version') {
      const line = reader.byKind<{ line: string; version: string }>('basis.version', (r) => r.line === id, 20);
      rec = line[0] ?? null;
      versions = line.map((l) => l.revision);
    }
    if (rec === null) throw new CliError('NOT_FOUND', `no ${label} ${id}`, { exitCode: EXIT.REFUSED });
    let derived: string | null = null;
    if (kind === 'object.version' && ctx.config.evaluatorCheckpoint !== null) {
      const sum = readCheckpointSummary(ctx.config.evaluatorCheckpoint);
      if (sum !== null) derived = `${faultTimeView(sum, sum.head ?? sum.revision).label(id) ?? 'unknown'} (checkpoint revision ${sum.revision})`;
    }
    const lines = [`${label[0]!.toUpperCase()}${label.slice(1)} ${id} (revision ${rec.revision}, ${time(rec.committedAt)})`, ...(derived !== null ? [`Label: ${derived}`] : []), JSON.stringify(rec.record, null, 2)];
    return { text: lines.join('\n'), json: { id, revision: rec.revision, committedAt: rec.committedAt, record: rec.record, label: derived, versions } };
  } finally {
    reader.close();
  }
}

async function showDelivery(ctx: Ctx, delivery: string): Promise<{ text: string; json: unknown }> {
  const reader = Layer2Reader.open(ledgerPathsOf(ctx.config).db);
  if (reader === null) throw new CliError('UNAVAILABLE', 'cannot read the main ledger (read-only)', { exitCode: EXIT.UNAVAILABLE });
  let d;
  try {
    d = findDelivery(reader, delivery);
  } finally {
    reader.close();
  }
  if (d === null) throw new CliError('NOT_FOUND', `no delivery ${delivery} (a delivery is recorded once its ref is created)`, { exitCode: EXIT.REFUSED });
  const landing = await deliveryLandingState(ctx, d.record);
  const lines = [`Delivery ${d.record.delivery} (mission ${d.record.mission}, ${time(d.committedAt)})`, `Delivery commit ${d.record.commit}, base ${d.record.base}, ref ${d.record.ref}`, `Landing: ${landing.summary}`];
  return { text: lines.join('\n'), json: { delivery: d.record, revision: d.revision, landing } };
}

async function showAlert(ctx: Ctx, alert: string): Promise<{ text: string; json: unknown }> {
  const n = (await syncedNotices(ctx)).find((x) => x.id === alert || x.id.endsWith(alert));
  if (n === undefined) throw new CliError('NOT_FOUND', `no notice ${alert}`, { exitCode: EXIT.REFUSED });
  markDelivered(ctx.config.stateDir, [n.id], ctx.now);
  await syncNotices(ctx.ledger(2_000), ctx.config.stateDir);
  const lines = renderNotice(n, ctx.io.env);
  lines.push(`  Facts: ${JSON.stringify(n.detail).slice(0, 2000)}`);
  return { text: lines.join('\n'), json: { notice: n, page: wiPagePath(n.wi, ctx.io.env) } };
}

export const showCmd: Command = {
  name: 'show',
  summary: 'layers 1 and 2: a mission, task, requirement item, object, delivery, stop or notice',
  usage: 'mp show mission|task|requirement|object|delivery|stop|alert <id>',
  flags: {},
  changesState: false,
  async run(ctx, args) {
    const kind = positional(args, 0, 'kind (mission|task|requirement|object|delivery|stop|alert)');
    const id = positional(args, 1, 'id');
    let r: { text: string; json: unknown };
    switch (kind) {
      case 'mission':
        r = await showMission(ctx, id);
        break;
      case 'task':
        r = await showTask(ctx, id);
        break;
      case 'requirement':
        r = showFact(ctx, 'basis.version', id, 'requirement item');
        break;
      case 'object':
        r = showFact(ctx, 'object.version', id, 'object');
        break;
      case 'delivery':
        r = await showDelivery(ctx, id);
        break;
      case 'stop':
        r = await showStop(ctx, id);
        break;
      case 'alert':
        r = await showAlert(ctx, id);
        break;
      default:
        throw usage(`show takes mission, task, requirement, object, delivery, stop or alert, not ${kind}`);
    }
    return ok(r.text, r.json);
  },
};

export const opsCmd: Command = {
  name: 'ops',
  summary: 'the actions the PM took through the CLI (operation id, command, WI, state), for review',
  usage: 'mp ops [--all]',
  flags: { all: 'boolean' },
  changesState: false,
  async run(ctx, args) {
    const limit = flagBool(args, 'all') ? 1000 : 30;
    // The ledger's record (recordPmAction); the CLI's journal when the ledger is down.
    const fromLedger = await ctx.tryCall('pmActions', { limit });
    const rows: Array<{ op: string; command: string; wi: string | null; state: string; at: number }> = fromLedger.ok
      ? (fromLedger.value as Array<{ action: string; command: string; wi: string | null; state: string; startedAt: number }>).map((a) => ({ op: a.action, command: a.command, wi: a.wi, state: a.state, at: a.startedAt }))
      : ctx.journal.list(limit).map((r) => ({ op: r.op, command: r.command, wi: r.wi, state: r.state, at: r.startedAt }));
    const lines = rows.map((r) => `${time(r.at)} ${r.op} ${r.command}${r.wi ? ` (${r.wi})` : ''}: ${r.state}`);
    return ok(lines.length === 0 ? 'No actions recorded yet.' : lines.join('\n'), { ops: rows, source: fromLedger.ok ? 'ledger' : 'journal' });
  },
};
