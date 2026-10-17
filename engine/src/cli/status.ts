// The layered reads (design 4.1 §8; v51 §10.2): layer 0 (`mp read status`: a fixed-size summary
// the PM reads first, plus what changed since the maintainer last asked), layers 1-2
// (`mp read show <kind> <id>`, with the leaves' paths), layer 3 (`mp read leaf`). Layer 0 has no
// scheduler, isolation or spend fields any more; it shows the dispatches in flight and their age.
// Notices are shown, never marked: only `mp pm next` marks them delivered.

import type { MissionId } from '../common/ids.ts';
import { labelSummary, OLDER_ENVIRONMENT, olderEnvironmentProof, recordedEnvironment } from '../evaluator/index.ts';
import { explorationState } from '../flow/exploration/flow.ts';
import { PLAN_LINE } from '../flow/plandoc.ts';
import { activeStops, cursor, deliveryInfo, flowEvents, listMissions, openIntents, setCursor, taskQueue, type Db } from '../memory/index.ts';
import { listNotices, readSteps, type ProcessContext } from '../process/index.ts';
import type { Project } from './project.ts';
import { age, clip, filler, section, short, wiText } from './render.ts';
import { buildGraph, resolveNodes, show, type Graph, type GNode } from './tree.ts';
import { entryLines, resolveSubtasks, type Layer1Entry, type Resolved } from './layers.ts';
import { describeScope } from './stopDetect.ts';

/** The cursor of "since the maintainer last asked" (§3.2 item 7). */
export const ASKED_CURSOR = 'asked';

export interface Layer0 {
  readonly format: 'mp41.status.v1';
  readonly project: string;
  readonly head: number;
  readonly problems: Project['problems'];
  readonly stops: ReadonlyArray<{ stop: string; scope: string; words: string; wordsEntry: string | null }>;
  readonly missions: ReadonlyArray<{ mission: string; state: string; queued: number; inFlight: number; tasks: number; deliveries: ReadonlyArray<{ delivery: string; state: string; landed: boolean | null }> }>;
  readonly inFlight: ReadonlyArray<{ dispatch: string; seat: string; step: string; mission: string; ageMs: number; filler: string }>;
  readonly waitingOnUser: ReadonlyArray<{ mission: string; escalation: string; summary: string; options: readonly string[] }>;
  readonly notices: ReadonlyArray<{ id: string; wi: string | null; state: string; trigger: string; mission: string | null }>;
  readonly labels: { readonly recomputing: boolean; readonly toVisit: number; readonly toRecompute: number; readonly counts: Readonly<Record<string, number>>; readonly proofDebt: number; readonly cycles: number };
  readonly landingsOpen: ReadonlyArray<{ intent: string; delivery: string | null }>;
  readonly environment: string | null;
  /** 4.1.2: current proof resting on runs recorded under an older environment identity (it still counts; shown "older environment"). */
  readonly olderEnvironment: { readonly runs: number; readonly targets: number };
  readonly since: { readonly revision: number; readonly changes: Readonly<Record<string, number>> } | null;
}

const CHANGE_KINDS: Readonly<Record<string, string>> = {
  'user.words': 'words recorded',
  'dispatch.claimed': 'dispatches',
  'dispatch.handback': 'hand-backs',
  'dispatch.released': 'releases',
  judgment: 'judgments',
  'object.version': 'object versions',
  evidence: 'runs',
  'delivery.recorded': 'deliveries',
  'stop.committed': 'stops',
  alert: 'notices',
};

/**
 * Layer 0: one read of the memory. `inScope` (the resolver's): an escalation the flows no longer
 * consume (its task dropped by a re-plan, its PM batch superseded) is not waiting on the user.
 */
export function layer0(p: Project, inScope: (mission: string, subject: string) => boolean = () => true): Layer0 {
  const ctx = p.ctx;
  const steps = readSteps(ctx);
  const data = ctx.memory.data;
  return ctx.memory.read((db: Db) => {
    const stops = activeStops(db).map((s) => ({ stop: String(s.stop), scope: describeScope(s.scope), words: clip(s.words, 120), wordsEntry: s.wordsEntry }));
    const landed = new Set<string>();
    for (const r of db.stmt("SELECT delivery FROM intents WHERE kind = 'landing' AND state = 'done'").all() as Array<{ delivery: string | null }>) {
      try {
        const d = JSON.parse(r.delivery ?? 'null') as { mission?: string; op?: string } | null;
        if (d !== null) landed.add(`${d.mission}/${d.op}`);
      } catch {
        /* not a delivery intent */
      }
    }
    const missions = listMissions(db, 'all').map((m) => {
      const queued = taskQueue(db, m.mission).length;
      const inFlight = steps.inFlight.filter((d) => d.mission === m.mission).length;
      const tasks = Number((db.stmt('SELECT COUNT(*) AS n FROM tasks WHERE mission = ?').get(m.mission) as { n: number }).n);
      const dels = db.stmt('SELECT delivery, state, commit_id FROM deliveries WHERE mission = ? ORDER BY seq').all(m.mission) as Array<{ delivery: string; state: string; commit_id: string }>;
      return {
        mission: String(m.mission),
        state: m.state,
        queued,
        inFlight,
        tasks,
        deliveries: dels.map((d) => ({ delivery: d.delivery, state: d.state, landed: landed.has(`${m.mission}/${d.delivery}`) })),
      };
    });
    const notices = listNotices(db, data).map((n) => ({ id: n.id, wi: n.wi, state: n.state, trigger: clip(n.trigger, 160), mission: n.mission }));
    const sum = labelSummary(db);
    const env = recordedEnvironment(db);
    const older = olderEnvironmentProof(db);
    const c = cursor(db, ASKED_CURSOR);
    let since: Layer0['since'] = null;
    if (c !== null) {
      const changes: Record<string, number> = {};
      for (const r of db.stmt('SELECT kind, COUNT(*) AS n FROM log WHERE rev > ? GROUP BY kind').all(Number(c.rev)) as Array<{ kind: string; n: number }>) {
        const k = CHANGE_KINDS[r.kind];
        if (k !== undefined) changes[k] = (changes[k] ?? 0) + Number(r.n);
      }
      since = { revision: Number(c.rev), changes };
    }
    return {
      format: 'mp41.status.v1',
      project: p.dir,
      head: Number(ctx.memory.head()),
      problems: p.problems,
      stops,
      missions,
      inFlight: steps.inFlight.map((d) => ({ dispatch: d.dispatch, seat: d.seat, step: d.step, mission: String(d.mission), ageMs: d.ageMs, filler: filler(d.filler) })),
      waitingOnUser: steps.waitingOnUser.filter((w) => inScope(String(w.mission), w.subject)).map((w) => ({ mission: String(w.mission), escalation: w.escalation, summary: clip(w.summary, 160), options: w.options })),
      notices,
      labels: { recomputing: sum.status.recomputing, toVisit: sum.status.toVisit, toRecompute: sum.status.toRecompute, counts: sum.targets.labels, proofDebt: sum.proofDebt, cycles: sum.cycles },
      landingsOpen: openIntents(db)
        .filter((i) => i.kind === 'landing')
        .map((i) => ({ intent: i.intent, delivery: i.delivery?.op ?? null })),
      environment: env?.identity ?? null,
      olderEnvironment: { runs: older.runs.size, targets: older.targets.size },
      since,
    };
  });
}

export function layer0Text(l: Layer0): string {
  const dir = l.project;
  const lines: string[] = [`Mission Pipeline memory: ${dir}/.mission-pipeline (event ${l.head})`];
  // the problems found at the start of the command are printed once, above this answer (main.ts)
  lines.push(...section('Stops in force', l.stops.map((s) => `${s.stop}: ${s.scope} — "${s.words}"${s.wordsEntry !== null ? ` (${s.wordsEntry})` : ''}`), 'none'));
  lines.push(
    ...section(
      'Missions',
      l.missions.map((m) => `${m.mission} (${m.state}): ${m.tasks} tasks, ${m.queued} ready or held, ${m.inFlight} in flight${m.deliveries.length > 0 ? `; deliveries: ${m.deliveries.map((d) => `${d.delivery} ${d.state}${d.state === 'recorded' ? (d.landed ? ', landed' : ', not landed') : ''}`).join(', ')}` : ''}`),
      'none (mp pm mission open <id>)',
    ),
  );
  lines.push(...section('Dispatches in flight', l.inFlight.map((d) => `${d.dispatch}: ${d.seat} on ${d.step} (${d.mission}), ${age(d.ageMs)}, ${d.filler}`), 'none'));
  lines.push(...section('Waiting on the user', l.waitingOnUser.map((w) => `${w.mission} ${w.escalation}: ${w.summary} (options: ${w.options.join(', ')}; mp pm answer)`), 'nothing'));
  lines.push(...section('Notices not acknowledged', l.notices.map((n) => `[${n.state}] ${n.id}${n.wi !== null ? ` ${wiText(n.wi, dir)}` : ''}: ${n.trigger}`), 'none'));
  const counts = Object.entries(l.labels.counts)
    .filter(([, n]) => n > 0)
    .map(([k, n]) => `${n} ${k}`)
    .join(', ');
  lines.push(`Labels: ${counts || 'none yet'}${l.labels.recomputing ? `; recomputing (${l.labels.toVisit} to visit, ${l.labels.toRecompute} to recompute)` : ''}${l.labels.proofDebt > 0 ? `; proof debt ${l.labels.proofDebt}` : ''}${l.labels.cycles > 0 ? `; ${l.labels.cycles} dependency cycle(s) (WI-16)` : ''}`);
  if (l.landingsOpen.length > 0) lines.push(...section('Landing intents open', l.landingsOpen.map((i) => `${i.intent} (delivery ${i.delivery ?? '?'}): WI-06`)));
  lines.push(`Environment identity: ${l.environment === null ? 'not recorded yet' : short(l.environment)}${l.olderEnvironment.runs > 0 ? `; ${l.olderEnvironment.targets} label(s) rest on ${l.olderEnvironment.runs} run(s) from an ${OLDER_ENVIRONMENT} (they still count; mp pm renew reruns them if the PM decides)` : ''}`);
  return lines.join('\n');
}

/**
 * `mp read status` under the read-depth rule (layers.ts): layer 0 with the count of the
 * persistently blocked subtasks, plus the layer-1 entries of exactly the subtasks whose state
 * changed since the user last asked (all of them at the first ask); none changed: layer 0 only.
 */
export interface StatusRead extends Layer0 {
  /** The head the answer was built from (the cursor moves there). */
  readonly asOf: number;
  readonly blocked: number;
  /** The layer-1 entries of the subtasks that changed since `since` (all of them at the first ask). */
  readonly changed: readonly Layer1Entry[];
  readonly recomputing: Resolved['recomputing'];
}

export async function readStatus(p: Project): Promise<StatusRead> {
  // one resolution: the changed list and the count of blocked subtasks come from the same result
  const r = await resolveSubtasks(p.ctx);
  const l = layer0(p, r.inScope);
  const changed = r.entries.filter((e) => (l.since === null || e.changedRev > l.since.revision) && e.kind !== 'step' && e.kind !== 'plan');
  return { ...l, asOf: r.head, blocked: r.blocked.length, changed, recomputing: r.recomputing };
}

export function statusText(s: StatusRead): string {
  const lines = [layer0Text(s), `Persistently blocked: ${s.blocked}${s.blocked > 0 ? ' (why: mp read blocked)' : ''}`];
  if (s.changed.length > 0) {
    lines.push(s.since === null ? 'Subtasks (the first ask):' : `Changed since the user last asked (event ${s.since.revision}):`, ...s.changed.flatMap((e) => entryLines(e).map((x) => `  ${x}`)));
  } else lines.push(s.since === null ? 'No subtasks yet.' : `Nothing changed since the user last asked (event ${s.since.revision}).`);
  return lines.join('\n');
}

/**
 * Move "since the maintainer last asked" to `head`, the head the answer was built from: a change
 * that landed while it was built is shown again next time, never lost.
 */
export function markAsked(ctx: ProcessContext, head: number): boolean {
  try {
    ctx.memory.write({}, (tx) => setCursor(tx, { cursor: ASKED_CURSOR, rev: head }));
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- mp read show <kind> <id>

export const SHOW_KINDS: readonly string[] = ['mission', 'words', 'requirement', 'plan', 'object', 'task', 'dispatch', 'judgment', 'run', 'commit', 'delivery', 'landing', 'escalation', 'decision', 'exploration', 'stop', 'notice'];

export interface ShowResult {
  readonly text: string;
  readonly json: unknown;
}

function linksOf(g: Graph, n: GNode): { restsOn: string[]; restedOnBy: string[] } {
  const name = (k: string): string => {
    const x = g.nodes.get(k);
    return x === undefined ? k : `${x.kind} ${x.kind === 'commit' ? short(x.id) : x.id}`;
  };
  return {
    restsOn: (g.out.get(n.key) ?? []).map((e) => `${e.rel} ${name(e.to)}`),
    restedOnBy: (g.inn.get(n.key) ?? []).map((e) => `${name(e.from)} (${e.rel})`),
  };
}

function nodeBlock(ctx: ProcessContext, g: Graph, n: GNode): { lines: string[]; json: unknown } {
  const s = show(ctx, n);
  const l = linksOf(g, n);
  const lines = [
    `${s.kind} ${s.id}${s.title !== '' ? ` — ${s.title}` : ''}`,
    ...(s.state !== null ? [`  state: ${s.state}`] : []),
    ...(s.checks !== null ? [`  checks: ${s.checks}`] : []),
    ...(s.by !== null ? [`  by: ${s.by}`] : []),
    ...s.leaves.map((x) => `  leaf: ${x.path}${x.status === 'ok' ? '' : ` (${x.status === 'missing' ? 'leaf missing' : x.status === 'edited' ? 'leaf edited after it was recorded' : 'not recorded'})`}`),
    ...section('  rests on', l.restsOn),
    ...section('  rested on by', l.restedOnBy),
  ];
  return { lines, json: { node: s, ...l } };
}

/** Layers 1-2 for one item. */
export async function showItem(p: Project, kind: string, id: string): Promise<ShowResult | null> {
  const ctx = p.ctx;
  if (kind === 'notice') {
    const n = ctx.memory.read((db) => listNotices(db, ctx.memory.data, { includeAcknowledged: true })).find((x) => x.id === id);
    if (n === undefined) return null;
    const text = [`notice ${n.id} [${n.state}] (${n.category})${n.mission !== null ? ` in ${n.mission}` : ''}`, ...(n.wi !== null ? [`  WI: ${wiText(n.wi, p.dir)}`] : []), `  trigger: ${n.trigger}`, ...(n.defaultAction !== null ? [`  default action taken: ${n.defaultAction}`] : []), ...(n.askUser ? ['  ask the user'] : []), `  detail: ${clip(JSON.stringify(n.detail), 600)}`];
    return { text: text.join('\n'), json: n };
  }
  if (kind === 'mission') {
    const g = buildGraph(ctx, { mission: id });
    const known = ctx.memory.read((db) => listMissions(db, 'all').some((m) => m.mission === id));
    if (!known) return null;
    const byKind = new Map<string, GNode[]>();
    for (const n of g.nodes.values()) if (n.mission === id) byKind.set(n.kind, [...(byKind.get(n.kind) ?? []), n]);
    const lines = [`mission ${id}`];
    for (const k of ['requirement', 'plan', 'task', 'dispatch', 'object', 'judgment', 'delivery', 'escalation', 'exploration']) {
      const xs = (byKind.get(k) ?? []).sort((a, b) => a.rev - b.rev);
      if (xs.length === 0) continue;
      lines.push(`${k}s (${xs.length}):`, ...xs.slice(0, 50).map((n) => `  ${n.id}${n.state !== null ? ` [${n.state}]` : ''}${n.title !== '' ? ` — ${clip(n.title, 100)}` : ''}`));
    }
    lines.push(`(the whole mission as one tree: mp read tree ${id})`);
    return { text: lines.join('\n'), json: { mission: id, nodes: [...g.nodes.values()].filter((n) => n.mission === id).map((n) => show(ctx, n)) } };
  }
  if (kind === 'exploration') return showExploration(p, id);
  const g = buildGraph(ctx);
  const want = kind === 'plan' || kind === 'object' ? ['plan', 'object'] : [kind];
  const found = resolveNodes(g, ctx, id, want as readonly GNode['kind'][]).filter((n) => want.includes(n.kind));
  if (found.length === 0) return null;
  const blocks = found.map((n) => nodeBlock(ctx, g, n));
  const extra: string[] = [];
  const extraJson: Record<string, unknown> = {};
  if (kind === 'delivery' && found[0] !== undefined) {
    const [m, d] = found[0].id.split('/') as [string, string];
    const info = ctx.memory.read((db) => deliveryInfo(db, m as MissionId, d));
    if (info !== null) {
      extra.push(`  target branch: ${info.target ?? '?'}; base ${short(info.base)}; delivery commit ${short(info.commit)}; ref ${info.ref}`);
      const intents = ctx.memory.read((db) => db.stmt("SELECT intent, state FROM intents WHERE kind = 'landing' AND delivery LIKE ?").all(`%"op":"${d}"%`) as Array<{ intent: string; state: string }>);
      extra.push(...section('  landing intents', intents.map((i) => `${i.intent}: ${i.state === 'authorized' ? 'open (WI-06)' : i.state}`), 'none'));
      const now = ctx.git.runSync(['rev-parse', '--verify', '--quiet', '--end-of-options', `refs/heads/${info.target ?? ctx.targetBranch}^{commit}`], { cwd: ctx.projectDir });
      extra.push(`  ${info.target ?? ctx.targetBranch} is now at ${now.code === 0 ? short(now.stdout.toString('utf8').trim()) : '(absent)'}`);
      extraJson['delivery'] = info;
      extraJson['landingIntents'] = intents;
    }
  }
  if (kind === 'plan') {
    // the mechanical checks' failure texts, as the flow recorded them (the event's own body; 4.1.2)
    const checks = ctx.memory.read((db) =>
      found.filter((n) => n.mission !== null).flatMap((n) =>
        flowEvents(db, { mission: n.mission as MissionId, line: PLAN_LINE, event: 'mechanical-check', limit: 10_000 })
          .filter((e) => e.key === n.id)
          .map((e) => ({ plan: n.id, ...(JSON.parse(ctx.memory.data.text(e.body)) as { ok?: boolean; failures?: string[]; orderChanges?: string[] }) })),
      ),
    );
    for (const c of checks) {
      if (c.ok === true && (c.orderChanges ?? []).length === 0) continue;
      extra.push(...section(`  mechanical checks of ${c.plan}: ${c.ok === true ? 'passed' : `failed (${(c.failures ?? []).length})`}`, [...(c.failures ?? []).map((f) => `  failed: ${f}`), ...(c.orderChanges ?? []).map((o) => `  order change (to the Secretary): ${o}`)]));
    }
    extraJson['mechanicalChecks'] = checks;
  }
  if (kind === 'dispatch' && found[0] !== undefined) {
    const d = found[0].id;
    const reads = ctx.memory.read((db) => {
      const info = db.stmt('SELECT mission FROM dispatches WHERE dispatch = ?').get(d) as { mission: string } | undefined;
      return info === undefined ? [] : flowEvents(db, { mission: info.mission as MissionId, line: `dispatch:${d}`, event: 'read', limit: 10_000 }).map((e) => e.key);
    });
    if (reads.length > 0) extra.push(`  material pages read: ${reads.join(', ')}`);
    extraJson['reads'] = reads;
  }
  return { text: [...blocks.flatMap((b) => b.lines), ...extra].join('\n'), json: { items: blocks.map((b) => b.json), ...extraJson } };
}

/** `mp read show exploration <id>` (decision 5): findings, dispositions, Stabilizer verdicts per round. */
async function showExploration(p: Project, raw: string): Promise<ShowResult | null> {
  const ctx = p.ctx;
  const [m, x] = raw.includes('/') ? (raw.split('/', 2) as [string, string]) : [null, raw];
  const missions = m !== null ? [m] : ctx.memory.read((db) => (db.stmt("SELECT DISTINCT mission FROM flow_events WHERE line = ?").all(`exploration:${x}`) as Array<{ mission: string }>).map((r) => r.mission));
  if (missions.length === 0) return null;
  const out: string[] = [];
  const json: unknown[] = [];
  for (const mission of missions) {
    const s = await explorationState(ctx.ports(), mission as MissionId, x);
    if (s.defined === null) continue;
    const def = s.def;
    out.push(`exploration ${x} of mission ${mission}${s.stopped !== null ? ` — stopped (${s.stopped.reason}${s.stopped.wi !== null ? `, ${s.stopped.wi}` : ''})` : ` — turn: ${s.turn}`}`);
    if (def !== null) out.push(`  question: ${clip(String((def as unknown as Record<string, unknown>)['question'] ?? ''), 200)}`, `  the user's goal: ${clip(String((def as unknown as Record<string, unknown>)['goal'] ?? ''), 200)}`);
    out.push(`  rounds: ${s.rounds} attacked; phase ${s.phase}; version: ${s.version?.id ?? 'none yet'} (${s.versions.length} version(s))`);
    if (s.drift !== null) out.push(`  awaiting a ruling (WI-33): round ${s.drift.round} drifting — ${clip(s.drift.reason, 160)}`);
    // the current settle (one per opening; a rerun after an environment change reopens it), then the history
    const lastSettle = s.settles.at(-1);
    if (s.settled !== null) out.push(`  settled: ${s.settled.body.outcome} (${s.settled.body.stop})${s.settled.body.artifact !== null ? ` on ${s.settled.body.artifact}` : ''}${s.settles.length > 1 ? ` (settle ${s.settled.n} of ${s.settles.length})` : ''}`);
    else if (lastSettle !== undefined) out.push(`  not settled now: reopened after an environment change; settled earlier: ${lastSettle.body.outcome} (${lastSettle.body.stop})${lastSettle.body.artifact !== null ? ` on ${lastSettle.body.artifact}` : ''}`);
    const rounds = new Map<number, typeof s.findings extends Map<string, infer F> ? F[] : never>();
    for (const f of s.findings.values()) rounds.set(f.round, [...(rounds.get(f.round) ?? []), f]);
    for (const [r, fs] of [...rounds.entries()].sort((a, b) => a[0] - b[0])) {
      const st = s.stabilizations.find((z) => z.round === r);
      out.push(`  round ${r}${st !== undefined ? ` — Stabilizer (${st.task}): ${st.drift.verdict}, version ${st.verdict}${st.drift.reason ? ` (${clip(st.drift.reason, 120)})` : ''}` : ' — not stabilized yet'}:`);
      for (const f of fs) {
        out.push(
          `    ${f.id} [${f.severity}${f.judgedSeverity !== null && f.judgedSeverity !== f.severity ? ` → ${f.judgedSeverity}` : ''}] ${clip(f.title, 100)} — ${f.status}; disposition: ${f.disposition?.action ?? 'none yet'}; Stabilizer: ${f.scope ?? 'not judged yet'}${f.question !== null ? `; question: ${clip(f.question, 100)}` : ''}`,
        );
      }
    }
    json.push({ mission, exploration: x, turn: s.turn, rounds: s.rounds, version: s.version, stopped: s.stopped, settled: s.settled, settles: s.settles, drift: s.drift, findings: [...s.findings.values()], stabilizations: s.stabilizations, evidence: [...s.evidence.values()] });
  }
  if (json.length === 0) return null;
  return { text: out.join('\n'), json };
}
