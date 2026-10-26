// `mp pm …`: the PM's commands (design 4.1 §5.1, §5.4, §6.1, §6.5-§6.7; decisions 1-4, 8, 9, 15,
// 18). Each one is a thin layer over src/process (A3), src/git (A4) and the memory (A1): it
// parses the arguments, calls the process, and renders the answer with the WI an exception names.
// The words a command rests on are named as words entries (`--words W-<n>`, decision 1).

import { readFileSync, writeFileSync } from 'node:fs';
import { sha256 } from '../../common/hash.ts';
import type { MissionId, ObjectVersionId, ProofUnitId, StopId } from '../../common/ids.ts';
import { ITEM_ID, missionIdProblem } from '../../common/ids.ts';
import { LOOP_KINDS, type LoopKind } from '../../common/records.ts';
import type { DeliveryResult } from '../../delivery/delivery.ts';
import type { DeliveryTarget } from '../../delivery/proofView.ts';
import { closeNotLanded, type LandingResult } from '../../git/land.ts';
import { detachDuplicateCheckout } from '../../git/pmActions.ts';
import {
  activeStops,
  deliveryInfo,
  latestUserWords,
  listMissions,
  narrowStop,
  releaseStop,
  scopeWithin,
  stopInfo,
  taskQueue,
  withdrawDelivery,
  wordsEntry,
  wordsOfMessage,
  type StopScope,
} from '../../memory/index.ts';
import {
  deliveryIdFor,
  targetKey,
  listNotices,
  parseFiller,
  pmAck,
  pmClean,
  pmClose,
  pmAnswer,
  pmConstraint,
  pmWithdrawConstraint,
  pmDeliver,
  pmDispatch,
  pmDrain,
  pmFullRun,
  pmReopenExploration,
  pmResnapshotExploration,
  pmFinish,
  pmGrant,
  pmLand,
  pmRebuild,
  pmLegalizationState,
  pmLegalize,
  pmMission,
  pmNext,
  pmPlan,
  pmRelease,
  pmRenew,
  pmRepair,
  pmRequirement,
  pmSay,
  pmStartLegalization,
  pmStop,
  pmWithdrawRequirement,
  wordsText,
  type NextReport,
  type ProcessContext,
} from '../../process/index.ts';
import { DECISION_OPTIONS, type DecisionOption } from '../../seat/cards/secretary.ts';
import { REPAIR_KINDS, type RepairKind } from '../../flow/plandoc.ts';
import { flagBool, flagList, flagStr, missionArg, positional, type ParsedArgs } from '../args.ts';
import { ok, type Command, type CommandResult, type RunContext } from '../command.ts';
import { CliError, EXIT, refused, usage } from '../errors.ts';
import { latestSession, type Project } from '../project.ts';
import { age, clip, filler, section, short, wiText } from '../render.ts';
import { describeScope, detectStop, parseScope, stopScopeFor, stopWords } from '../stopDetect.ts';
import { planTemplate } from '../templates.ts';
import { pmCoreText, pmHandbookPath, wiDir } from '../wi.ts';
import { fullRunLines } from './seat.ts';

const WORDS = /^W-[1-9][0-9]*$/;

function P(c: RunContext): Project {
  if (c.project === null) throw new CliError('NOT_INITIALIZED', 'no project', { exitCode: EXIT.NO_PROJECT });
  return c.project;
}

/** A words entry the command rests on (decision 1): `--words W-<n>`, checked to exist. */
function wordsArg(ctx: ProcessContext, args: ParsedArgs, required: boolean): string | null {
  const w = flagStr(args, 'words');
  if (w === null) {
    if (required) throw usage('--words W-<n>: the words entry this rests on (mp pm say records the user\'s message as W-<n>)');
    return null;
  }
  if (!WORDS.test(w)) throw usage(`--words is a words entry W-<n>, not ${JSON.stringify(w)}`);
  if (ctx.memory.read((db) => wordsEntry(db, w)) === null) throw refused('NO_WORDS', `there is no words entry ${w} (mp pm say records one)`);
  return w;
}

function wiLine(p: Project, wi: string | null): string[] {
  const t = wiText(wi, p.dir);
  return t === null ? [] : [`Follow ${t}.`];
}

// ---------------------------------------------------------------- session, say, next

const session: Command = {
  group: 'pm',
  name: ['session'],
  summary: 'start a PM session: record which harness and model fill the PM (decision 8); prints the handbook core',
  usage: 'mp pm session --filled-by "<harness>/<model>"',
  flags: { 'filled-by': 'string' },
  identity: (a) => ({ filler: parseFiller(flagStr(a, 'filled-by')) }),
  async run(c, args) {
    const p = P(c);
    const f = parseFiller(flagStr(args, 'filled-by'));
    if (f === null) throw usage('--filled-by "<harness>/<model>": who fills the PM in this session (information only)');
    const inFlight = p.ctx.memory.read((db) => db.stmt("SELECT dispatch, seat, task, created_at FROM dispatches WHERE state = 'in-flight' ORDER BY claimed_rev").all() as Array<{ dispatch: string; seat: string; task: string; created_at: number }>);
    const lines = [
      `PM session ${c.op} recorded: the PM is filled by ${filler(f)}. Every mp pm command from now on is attributed to it.`,
      ...(inFlight.length > 0 ? [`${inFlight.length} dispatch(es) in flight from earlier work: ${inFlight.map((d) => `${d.dispatch} (${d.seat}, ${age(c.now - Number(d.created_at))})`).join(', ')}. Decide per ${wiText('WI-28', p.dir)}.`] : []),
      '',
      `The handbook core (${pmHandbookPath(p.dir).startsWith(p.dir) ? '.mission-pipeline/pm/PM.md' : pmHandbookPath(p.dir)}):`,
      pmCoreText(p.dir),
      '',
      `Work instructions: read only the index (${wiDir(p.dir).startsWith(p.dir) ? '.mission-pipeline/pm/wi/INDEX.md' : `${wiDir(p.dir)}/INDEX.md`}). Next: mp pm next`,
    ];
    return ok(lines.join('\n'), { session: c.op, filler: f, inFlight: inFlight.map((d) => d.dispatch) });
  },
};

const say: Command = {
  group: 'pm',
  name: ['say'],
  summary: 'record the user\'s message verbatim as a words entry W-<n>, before anything else (§6.1; the same text again is the same entry, decision 9)',
  usage: 'mp pm say "<the message, verbatim>" | mp pm say --file <message.txt> | mp pm say --stdin',
  flags: { file: 'string', stdin: 'boolean' },
  identity: (a) => ({ text: a.positionals.join(' '), file: flagStr(a, 'file'), stdin: flagBool(a, 'stdin') }),
  async run(c, args) {
    const p = P(c);
    const file = flagStr(args, 'file');
    let text: string;
    if (file !== null) text = readFileSync(file, 'utf8');
    else if (flagBool(args, 'stdin')) {
      if (c.io.stdin === undefined) throw usage('--stdin: no standard input');
      text = c.io.stdin();
    } else {
      if (args.positionals.length === 0) throw usage('the user\'s message, verbatim (or --file <file>, --stdin)');
      text = args.positionals.join(' ');
    }
    if (text.trim() === '') throw usage('the message is empty');
    const r = pmSay(p.ctx, text);
    const stop = detectStop(text);
    const lines = [r.repeated ? `Already recorded as ${r.words} (the same text as the latest entry).` : `Recorded as ${r.words}.`];
    if (stop.detected) lines.push(`These words look like a stop (${stop.triggers.join(', ')}): if the user means it, at once \`mp pm stop "<the words>" --words ${r.words}\`.`);
    return ok(lines.join('\n'), { words: r.words, repeated: r.repeated, looksLikeStop: stop.detected });
  },
};

export function renderNext(p: Project, n: NextReport, hints: Readonly<Record<string, string | null>>): string {
  const lines: string[] = [];
  lines.push(
    ...section(
      'Notices (first)',
      n.notices.map((x) => `[${x.state}] ${x.id}${x.mission !== null ? ` (${x.mission})` : ''}: ${clip(x.trigger, 200)}${x.defaultAction ? ` — already done: ${clip(x.defaultAction, 120)}` : ''}${x.wi !== null ? ` [${wiText(x.wi, p.dir)}]` : ''}${x.askUser ? ' (ask the user)' : ''}`),
      'none',
    ),
  );
  lines.push(
    ...section(
      'Ready steps',
      n.ready.map((r) => `${r.step}: ${r.seat} (${r.kind}) in ${r.mission} — ${r.purpose}${r.parallel ? ' [parallel]' : ' [not in parallel]'}${r.dispatches > 0 ? ` (dispatched ${r.dispatches}× before)` : ''}${hints[r.seat] ? ` (hint: ${hints[r.seat]})` : ''}`),
      n.labels.recomputing ? 'none now (the labels are recomputing)' : 'none',
    ),
  );
  lines.push(...section('Held', n.held.map((h) => `${h.step}: ${h.seat} in ${h.mission} — ${h.why}${h.wi !== null ? ` [${wiText(h.wi, p.dir)}]` : ''}`)));
  lines.push(...section('Waiting on the user', n.waitingOnUser.map((w) => `${w.mission} ${w.escalation}: ${clip(w.summary, 200)} — options ${w.options.join(', ')} (mp pm answer ${w.mission} ${w.escalation} --option <option> --words W-<n>)`)));
  lines.push(...section('In flight', n.inFlight.map((d) => `${d.dispatch}: ${d.seat} on ${d.step} (${d.mission}), ${age(d.ageMs)}, ${filler(d.filler)}`)));
  if (n.labels.recomputing) lines.push(`Labels recomputing: ${n.labels.toVisit} to visit, ${n.labels.toRecompute} to recompute${n.labels.since !== null ? ` (since ${age(Date.now() - n.labels.since)})` : ''}; decisions that need "proven" wait.`);
  if (n.errors.length > 0) lines.push(...section('Flow errors (each also a notice)', n.errors));
  if (n.ready.length > 0) lines.push('', 'Dispatch: mp pm dispatch <step> --filled-by "<harness>/<model>", then start the seat with the prompt it prints.');
  return lines.join('\n');
}

const next: Command = {
  group: 'pm',
  name: ['next'],
  summary: 'notices first, then the ready steps, what is held, what waits on the user, and the dispatches in flight (§5.1)',
  usage: 'mp pm next',
  flags: {},
  decides: true,
  async run(c) {
    const p = P(c);
    const n = await pmNext(p.ctx);
    const hints = p.config.fillers;
    const nudge = latestSession(p.ctx.memory) === null ? ['(no PM session is recorded: mp pm session --filled-by "<harness>/<model>")'] : [];
    const stops = p.ctx.memory.read((db) => activeStops(db));
    const stopLines = stops.length > 0 ? [`Stops in force: ${stops.map((x) => `${x.stop} (${describeScope(x.scope)})`).join(', ')}; nothing in their scope is dispatched, accepted or landed.`] : [];
    return ok([...nudge, ...stopLines, renderNext(p, n, hints)].join('\n'), { ...n, stops: stops.map((x) => ({ stop: x.stop, scope: x.scope, wordsEntry: x.wordsEntry })) });
  },
};

// ---------------------------------------------------------------- dispatch, release, renew, drain

const dispatch: Command = {
  group: 'pm',
  name: ['dispatch'],
  summary: 'claim a ready step once; prints the dispatch id and the fixed prompt for your harness\'s sub-agent (§5.1)',
  usage: 'mp pm dispatch <step> --filled-by "<harness>/<model>"',
  flags: { 'filled-by': 'string' },
  decides: true,
  async run(c, args) {
    const p = P(c);
    const step = positional(args, 0, 'step (mp pm next lists the ready steps)');
    const d = pmDispatch(p.ctx, step, { filledBy: flagStr(args, 'filled-by') });
    const lines = [
      `Dispatched ${d.dispatch}: ${d.seat} (${d.kind}) for step ${d.step} in ${d.mission}.`,
      `Card: .mission-pipeline/${d.cardLeaf} (the seat reads it with mp seat ${d.dispatch} card)`,
      ...(d.worktree !== null ? [`Worktree: ${d.worktree}`] : []),
      `Hand-back files: ${d.files.report}, ${d.files.result}`,
      '',
      'Start a sub-agent in your harness with exactly this prompt:',
      d.prompt,
    ];
    return ok(lines.join('\n'), { dispatch: d.dispatch, step: d.step, seat: d.seat, kind: d.kind, mission: d.mission, card: d.cardLeaf, worktree: d.worktree, files: d.files, prompt: d.prompt });
  },
};

const release: Command = {
  group: 'pm',
  name: ['release'],
  summary: 'release a dispatch whose seat ended without a hand-back: --ended (confirmed) or --abandoned (not confirmed) (§5.4, WI-28)',
  usage: 'mp pm release <dispatch> --ended | --abandoned',
  flags: { ended: 'boolean', abandoned: 'boolean' },
  async run(c, args) {
    const p = P(c);
    const d = positional(args, 0, 'dispatch');
    const ended = flagBool(args, 'ended');
    const abandoned = flagBool(args, 'abandoned');
    if (ended === abandoned) throw usage('give exactly one of --ended (your harness confirmed the seat ended) and --abandoned (not confirmed)');
    const r = await pmRelease(p.ctx, d, ended ? 'ended' : 'abandoned');
    const lines = [
      r.released ? `${d} released (${r.how}).` : `${d} was already handed back or released: nothing changed.`,
      `Worktree: ${r.worktree === 'none' ? 'none' : r.worktree === 'removed' ? 'removed' : 'kept (released as abandoned: it stays until --ended)'}.`,
      ...(r.requeued ? [`The step is ready again (re-dispatches ${r.attempts}/${r.allowed}).`] : []),
      ...(r.exhausted ? [`The lineage's re-dispatches are used up (${r.attempts}/${r.allowed}): the Secretary decides. ${wiLine(p, 'WI-08').join('')}`] : []),
      ...(r.notes ?? []),
    ];
    return ok(lines.join('\n'), r, r.exhausted ? EXIT.REFUSED : 0);
  },
};

/** Bytes for people: B, KB, MB, GB (powers of 1024, one decimal). */
function bytesText(n: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = n;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u++;
  }
  return u === 0 ? `${n} B` : `${v.toFixed(1)} ${units[u]}`;
}

const clean: Command = {
  group: 'pm',
  name: ['clean'],
  summary: 'remove now what no running mp process owns under .mission-pipeline/tmp/ and the worktrees of dispatches that are over; reports the bytes freed (safe while other mp commands run)',
  usage: 'mp pm clean [--mission <m>]   (--mission: only that mission\'s dispatch directories and worktrees; ownerless scratch always goes)',
  flags: { mission: 'string' },
  async run(c, args) {
    const p = P(c);
    const m = flagStr(args, 'mission');
    if (m !== null && missionIdProblem(m) !== null) throw usage(`--mission: ${missionIdProblem(m)}`);
    const r = pmClean(p.ctx, { mission: m as MissionId | null });
    const lines = [
      `Freed ${bytesText(r.totalBytes)}.`,
      ...section('Removed under .mission-pipeline/tmp/', r.removed.map((x) => `${x.path}: ${x.why}${x.done ? '' : ' (not finished: it waits in the trash)'}; ${bytesText(x.bytes)}`), 'nothing'),
      ...section('Worktrees removed', r.worktrees.map((w) => `${w.path} (${w.dispatch}): ${bytesText(w.bytes)}`)),
      ...section('Worktrees kept', r.worktreesKept.map((w) => `${w.dispatch}: ${w.why}`)),
      ...(r.pending > 0 ? [`${r.pending} director${r.pending === 1 ? 'y' : 'ies'} in the trash could not be deleted now; mp pm next and mp pm clean try again.`] : []),
      ...section('Left in place', r.kept.map((k) => `${k.path}: ${k.why}`)),
    ];
    return ok(lines.join('\n'), r);
  },
};

const renew: Command = {
  group: 'pm',
  name: ['renew'],
  summary: 'the PM\'s explicit tool after an environment change: rerun the declared commands of runs from older environments under this one; equal outputs renew the evidence without a seat (§6.5; never a ready step)',
  usage: 'mp pm renew',
  flags: {},
  decides: true,
  async run(c) {
    const p = P(c);
    const r = await pmRenew(p.ctx);
    const lines = [
      `Environment identity: ${short(r.environment)}.`,
      ...section('Reruns', r.reruns.map((x) => `${x.original} → ${x.run}: ${x.passed ? 'passed' : 'failed'}; renewed ${x.renewed.length}${x.refused.length > 0 ? `; refused ${x.refused.map((y) => `${y.judgment} (${y.reason})`).join(', ')}` : ''}`), 'nothing to rerun'),
      ...section('Need a Reviewer (a new judgment of the same position)', r.reviews.filter((x) => !x.renewable).map((x) => `${x.judgment} on ${x.target} (${x.review})${x.reason !== null ? `: ${x.reason}` : ''}`)),
      ...section('Not rerun', r.skipped.map((x) => `${x.evidence}: ${x.why}`)),
      'Then: mp pm next',
    ];
    return ok(lines.join('\n'), r);
  },
};

const drain: Command = {
  group: 'pm',
  name: ['drain'],
  summary: 'work through label batches until the frontier is empty (§4.1, WI-32); stop dispatching new work first',
  usage: 'mp pm drain [--max-batches <n>]',
  flags: { 'max-batches': 'string' },
  async run(c, args) {
    const p = P(c);
    const mb = flagStr(args, 'max-batches');
    const n = mb === null ? undefined : Number(mb);
    if (n !== undefined && (!Number.isSafeInteger(n) || n < 1)) throw usage('--max-batches is a positive integer');
    const r = pmDrain(p.ctx, n === undefined ? {} : { maxBatches: n });
    return ok(`${r.batches} batch(es), ${r.units} units in ${r.ms} ms; ${r.status.recomputing ? `still recomputing (${r.status.toVisit} to visit, ${r.status.toRecompute} to recompute)` : 'the labels are current'}.`, r);
  },
};

// ---------------------------------------------------------------- stops (written first, Appendix E)

function knownMissions(ctx: ProcessContext): { known: string[]; open: string[] } {
  return ctx.memory.read((db) => {
    const open = listMissions(db, 'open').map((m) => String(m.mission));
    const busy = [...taskQueue(db).map((t) => String(t.mission)), ...(db.stmt("SELECT DISTINCT mission FROM dispatches WHERE state = 'in-flight'").all() as Array<{ mission: string }>).map((r) => r.mission)];
    const related = [...new Set([...open, ...busy])];
    return { known: [...new Set([...listMissions(db, 'all').map((m) => String(m.mission)), ...busy])], open: related };
  });
}

function stopIdFor(op: string): StopId {
  return `stop-${sha256(op).slice(0, 20)}` as StopId;
}

/** The words entry a stop came from: --words, else the latest entry when it holds the stop's words verbatim. */
function stopEntry(ctx: ProcessContext, args: ParsedArgs, words: string): string | null {
  const given = flagStr(args, 'words');
  if (given !== null) {
    if (!WORDS.test(given)) throw usage(`--words is a words entry W-<n>, not ${JSON.stringify(given)}`);
    return given;
  }
  return ctx.memory.read((db) => {
    const latest = latestUserWords(db, 1)[0];
    if (latest === undefined) return null;
    const w = wordsOfMessage(db, latest.message);
    if (w === null) return null;
    try {
      return ctx.memory.data.text(w.text).includes(words) ? w.words : null;
    } catch {
      return null;
    }
  });
}

function scopeArg(v: string): StopScope {
  const s = parseScope(v);
  if (s === null) throw usage(`--scope is all, mission:<id> or capability:<name>, not ${v}`);
  return s;
}

const stop: Command = {
  group: 'pm',
  name: ['stop'],
  summary: 'record a stop at once, at a conservative scope; then stop the running seats in your harness (§6.6)',
  usage: 'mp pm stop "<the user\'s words>" [--scope all|mission:<id>|capability:<name>] [--words W-<n>]',
  flags: { scope: 'string', words: 'string' },
  stop: true,
  async run(c, args) {
    const p = P(c);
    const words = args.positionals.join(' ');
    if (words.trim() === '') throw usage('the user\'s words, as they said them');
    const flag = flagStr(args, 'scope');
    let scope: StopScope;
    let why: string;
    if (flag !== null) {
      const s = scopeArg(flag);
      const bad = s.kind === 'mission' ? missionIdProblem(s.mission) : null;
      // a stop is never refused: a mission id no mission can have widens it to everything
      scope = bad === null ? s : { kind: 'all' };
      why = bad === null ? 'as --scope says' : `--scope names no possible mission (${bad}): restricts everything`;
    } else {
      const m = knownMissions(p.ctx);
      const d = stopScopeFor(words, { ...detectStop(words), detected: true }, { knownMissions: m.known, openMissions: m.open, complete: true });
      scope = d.scope;
      why = d.why;
    }
    const id = stopIdFor(c.op!);
    const r = pmStop(p.ctx, { stop: id, scope, words: stopWords(words), wordsEntry: stopEntry(p.ctx, args, words) });
    const text = [`Stop ${id} ${r.committed ? 'recorded' : 'was already recorded'}: ${describeScope(scope)} (${why}).`, r.message, 'A stop in error or too wide: confirm with the user, then mp pm stop-narrow or mp pm stop-release.'].join('\n');
    return ok(text, { stop: id, scope, why, committed: r.committed, inFlight: r.inFlight });
  },
};

const stopNarrow: Command = {
  group: 'pm',
  name: ['stop-narrow'],
  summary: 'after confirming with the user, narrow a stop (the narrower one is written and the old one released in one write)',
  usage: 'mp pm stop-narrow <stop> --scope mission:<id>|capability:<name> [--words W-<n>]',
  flags: { scope: 'string', words: 'string' },
  stop: true,
  async run(c, args) {
    const p = P(c);
    const old = positional(args, 0, 'stop id');
    const flag = flagStr(args, 'scope');
    if (flag === null) throw usage('--scope: the narrower scope');
    const scope = scopeArg(flag);
    const bad = scope.kind === 'mission' ? missionIdProblem(scope.mission) : null;
    if (bad !== null) throw usage(bad);
    const prev = p.ctx.memory.read((db) => stopInfo(db, old as StopId));
    const id = stopIdFor(c.op!);
    if (prev === null) throw refused('NOT_A_STOP', `there is no stop ${old}`);
    if (prev.state !== 'active') {
      if (prev.narrowedTo !== null) return ok(`Stop ${old} was already narrowed to ${prev.narrowedTo}.`, { old, stop: prev.narrowedTo, narrowed: false });
      throw refused('NOT_ACTIVE', `stop ${old} is released`);
    }
    if (!scopeWithin(scope, prev.scope)) throw refused('NOT_NARROWER', `the new scope (${describeScope(scope)}) is not inside the old one (${describeScope(prev.scope)}): narrowing only shrinks a scope; for another scope record a new stop, then release the old one`);
    if (JSON.stringify(scope) === JSON.stringify(prev.scope)) throw refused('SAME_SCOPE', `the new scope is the old one (${describeScope(scope)})`);
    const req = { stop: id, scope, words: stopWords(`${prev.words} (narrowed from ${old} after the PM confirmed with the user)`), at: c.now, wordsEntry: flagStr(args, 'words') ?? prev.wordsEntry };
    const r = p.ctx.memory.write({ op: `stop-narrow:${id}`, payload: { old, stop: req }, stop: true, command: 'stop-narrow', filler: p.ctx.filler }, (tx) => narrowStop(tx, { old: old as StopId, stop: req }));
    return ok(`Stop ${old} (${describeScope(prev.scope)}) narrowed to ${r.stop} (${describeScope(scope)}): the new one written and the old one released in one step.`, { old, stop: r.stop, scope, previousScope: prev.scope, narrowed: r.narrowed });
  },
};

const stopRelease: Command = {
  group: 'pm',
  name: ['stop-release'],
  summary: 'release a stop (work it cancelled does not come back by itself)',
  usage: 'mp pm stop-release <stop> [--words W-<n>]',
  flags: { words: 'string' },
  stop: true,
  async run(c, args) {
    const p = P(c);
    const id = positional(args, 0, 'stop id');
    const r = p.ctx.memory.write({ op: `stop-release:${id}:${c.op}`, payload: { stop: id }, stop: true, command: 'stop-release', filler: p.ctx.filler }, (tx) => releaseStop(tx, id as StopId));
    if (!r.released) {
      const st = p.ctx.memory.read((db) => stopInfo(db, id as StopId));
      if (st === null) throw refused('NOT_A_STOP', `there is no stop ${id}`);
      return ok(`Stop ${id} was already released.`, { stop: id, released: false });
    }
    return ok(`Stop ${id} released. Work it cancelled does not come back by itself: plan it again if needed.`, { stop: id, released: true, active: p.ctx.memory.read((db) => activeStops(db).length) });
  },
};

// ---------------------------------------------------------------- missions, requirements, constraints, plans

const mission: Command = {
  group: 'pm',
  name: ['mission'],
  summary: 'missions: open one, or list them',
  usage: 'mp pm mission open <mission> | mp pm mission list [--state open|closed|all]',
  flags: { state: 'string' },
  async run(c, args) {
    const p = P(c);
    const sub = positional(args, 0, 'open or list');
    if (sub === 'list') {
      const st = flagStr(args, 'state') ?? 'open';
      if (st !== 'open' && st !== 'closed' && st !== 'all') throw usage('--state is open, closed or all');
      const xs = p.ctx.memory.read((db) => listMissions(db, st));
      return ok(xs.length === 0 ? `No ${st === 'all' ? '' : `${st} `}missions.` : xs.map((m) => `${m.mission}: ${m.state}${m.closes > 0 ? ` (closed ${m.closes}×)` : ''}`).join('\n'), { missions: xs });
    }
    if (sub !== 'open') throw usage('mission takes open or list');
    const m = missionArg(args, 1);
    const r = pmMission(p.ctx, m);
    return ok(`Mission ${r.mission} is open.`, r);
  },
};

const ITEM_TYPES = ['goal', 'limit', 'authorization', 'acceptance', 'decision'] as const;

const requirement: Command = {
  group: 'pm',
  name: ['requirement'],
  summary: 'requirement items: add one quoting the user verbatim (or resting on an authorization), or withdraw one (§6.1)',
  usage:
    'mp pm requirement add <mission> <item> --type goal|limit|authorization|acceptance|decision --text "<item>" (--quote "<verbatim>" --words W-<n> | --authorization <item>) [--restatement "<text>"] [--confirmed-by W-<n>] [--notify "<condition>"] | mp pm requirement withdraw <mission> <item> --words W-<n> [--reason "<text>"]',
  flags: { type: 'string', text: 'string', quote: 'string', words: 'string', authorization: 'string', restatement: 'string', 'confirmed-by': 'string', notify: 'string', reason: 'string' },
  async run(c, args) {
    const p = P(c);
    const sub = positional(args, 0, 'add or withdraw');
    const m = missionArg(args, 1);
    const item = positional(args, 2, 'item id');
    if (!ITEM_ID.test(item)) throw usage(`an item id is letters, digits and "-" (at most 64): ${item}`);
    if (sub === 'withdraw') {
      const w = wordsArg(p.ctx, args, true)!;
      const reason = flagStr(args, 'reason') ?? `${wordsText(p.ctx, w)} (${w})`;
      await pmWithdrawRequirement(p.ctx, { mission: m, item, reason });
      return ok(`Requirement item ${item} of ${m} withdrawn; what rests on it drops (mp read from item.${m}.${item}).`, { mission: m, item, withdrawn: true });
    }
    if (sub !== 'add') throw usage('requirement takes add or withdraw');
    const type = flagStr(args, 'type');
    if (type === null || !(ITEM_TYPES as readonly string[]).includes(type)) throw usage(`--type is one of ${ITEM_TYPES.join(', ')}`);
    const text = flagStr(args, 'text');
    if (text === null || text.trim() === '') throw usage('--text: the item');
    const auth = flagStr(args, 'authorization');
    const quote = flagStr(args, 'quote');
    if (auth === null && quote === null) throw usage('every item points to its source: --quote "<the user\'s words, verbatim>" --words W-<n> (a decision: --authorization <item>)');
    const confirmed = flagStr(args, 'confirmed-by');
    const r = await pmRequirement(p.ctx, {
      mission: m,
      item,
      type: type as (typeof ITEM_TYPES)[number],
      text,
      ...(auth !== null ? { authorization: auth } : { quote: quote!, words: wordsArg(p.ctx, args, true)! }),
      ...(flagStr(args, 'restatement') !== null ? { restatement: flagStr(args, 'restatement')! } : {}),
      ...(confirmed !== null ? { confirmedBy: confirmed } : {}),
      ...(flagStr(args, 'notify') !== null ? { notifyCondition: flagStr(args, 'notify')! } : {}),
    });
    return ok(`Requirement item ${item} (${type}) of ${m} recorded as ${r.version}.`, { mission: m, item, version: r.version });
  },
};

const repair: Command = {
  group: 'pm',
  name: ['repair'],
  summary: 'a problem the user found trying the product, as a repair (D-10): the user\'s reason verbatim from their words, the kind you choose; the Architect amends the plan in effect under the mechanical checks only (about an exploration: one more round)',
  usage: 'mp pm repair <mission> --words W-<n> --kind defect|usability|missing|new-question --text "<the user\'s reason, verbatim from W-n>" [--about <task-id|exploration-id>]',
  flags: { words: 'string', kind: 'string', text: 'string', about: 'string' },
  async run(c, args) {
    const p = P(c);
    const m = missionArg(args, 0);
    const words = wordsArg(p.ctx, args, true)!;
    const kind = flagStr(args, 'kind');
    if (kind === null || !(REPAIR_KINDS as readonly string[]).includes(kind)) throw usage(`--kind is one of ${REPAIR_KINDS.join(', ')} (you choose it; the user's words are the reason)`);
    const text = flagStr(args, 'text');
    if (text === null || text.trim() === '') throw usage(`--text: the user's reason, verbatim from ${words}`);
    const about = flagStr(args, 'about');
    const r = await pmRepair(p.ctx, { mission: m, words, kind: kind as RepairKind, text, ...(about !== null ? { about } : {}) });
    const what = r.about?.kind === 'exploration' ? `exploration ${r.about.id} is reopened for one more round with it as an added question` : 'an Architect repair step amends the plan in effect (mechanical checks only); mp pm next lists it';
    return ok(`${r.repeated ? 'Repair already recorded' : 'Repair recorded'}: ${r.repair} (${kind}) of ${m}, from ${words}: ${what}.`, { mission: m, repair: r.repair, repeated: r.repeated, about: r.about });
  },
};

const constraint: Command = {
  group: 'pm',
  name: ['constraint'],
  summary: 'a long-term project constraint: an object constraint (a review duty; when unsure) or an execution instruction, with its scope',
  usage: 'mp pm constraint add [<recording-mission>] <constraint> --kind object|instruction --text "<constraint>" [--paths <pattern,...>] [--task-types <type,...>] [--mission <m>] [--words W-<n>]\n       mp pm constraint withdraw <constraint> --words W-<n>',
  flags: { kind: 'string', text: 'string', paths: 'list', 'task-types': 'list', mission: 'string', words: 'string' },
  async run(c, args) {
    const p = P(c);
    const action = positional(args, 0, 'add or withdraw');
    if (action === 'withdraw') {
      const id = positional(args, 1, 'constraint id');
      await pmWithdrawConstraint(p.ctx, { constraint: id, words: wordsArg(p.ctx, args, true)! });
      return ok(`Constraint ${id} withdrawn; its record is kept.`, { constraint: id, withdrawn: true });
    }
    if (action !== 'add') throw usage('constraint takes add or withdraw');
    const missionScope = flagStr(args, 'mission');
    if (missionScope !== null && missionIdProblem(missionScope) !== null) throw usage(`--mission: ${missionIdProblem(missionScope)}`);
    const legacy = args.positionals.length === 3;
    const m = legacy ? missionArg(args, 1) : (missionScope ?? 'project') as MissionId;
    const id = positional(args, legacy ? 2 : 1, 'constraint id');
    const kind = flagStr(args, 'kind');
    if (kind !== 'object' && kind !== 'instruction') throw usage('--kind is object or instruction (when unsure: object)');
    const text = flagStr(args, 'text');
    if (text === null || text.trim() === '') throw usage('--text: the constraint');
    const paths = flagList(args, 'paths');
    // the words the constraint came from (optional, as `withdraw` needs them): recorded with it
    const w = wordsArg(p.ctx, args, false);
    const r = await pmConstraint(p.ctx, { mission: m, constraint: id, kind, text, ...(missionScope !== null ? { missionScope } : {}), ...(w !== null ? { words: w } : {}), scope: { paths: paths.length > 0 ? [...paths] : ['**'], taskTypes: [...flagList(args, 'task-types')] } });
    return ok(`Constraint ${id} (${kind}) recorded as ${r.version}${w !== null ? ` on ${w}` : ''}.`, { mission: m, constraint: id, version: r.version, words: w });
  },
};

const plan: Command = {
  group: 'pm',
  name: ['plan'],
  summary: 'submit a PM plan batch (results level; explorations are plan elements); Calibrator ① checks it next. `mp pm plan template <mission>` prints its format, prefilled',
  usage: 'mp pm plan template <mission> [--file <plan.json>]   (an annotated, valid skeleton prefilled with the requirement items)\n       mp pm plan submit <mission> --file <plan.json> --words W-<n>[,W-<m>...] [--changed <item,...>] [--dependent <item,...>] [--mode stable|fast]\n       (the plan in effect submitted unchanged with new words or changed items re-checks that version: no new version, no Architect)',
  flags: { file: 'string', words: 'list', changed: 'list', dependent: 'list', mode: 'string' },
  identity: (a) => ({
    positionals: a.positionals,
    flags: a.flags,
    plan: (() => {
      try {
        return sha256(readFileSync(String(a.flags['file'] ?? ''), 'utf8'));
      } catch {
        return null;
      }
    })(),
  }),
  async run(c, args) {
    const p = P(c);
    const sub = positional(args, 0, 'submit or template');
    if (sub === 'template') {
      const m = missionArg(args, 1);
      const t = planTemplate(p.ctx, m);
      const json = `${JSON.stringify(t.template, null, 2)}\n`;
      const out = flagStr(args, 'file');
      if (out !== null) writeFileSync(out, json);
      const head = [
        `The PM plan of mission ${m}: ${t.items.length} requirement item(s) in force prefilled${t.words.length > 0 ? `, quoting ${t.words.join(', ')}` : ''}. The "_note" keys explain the fields; the plan's schema ignores them.`,
        out !== null ? `Written to ${out}. Edit it, then: mp pm plan submit ${m} --file ${out} --words ${t.words.join(',') || 'W-<n>'}` : `Save the JSON below as plan.json (or: mp pm plan template ${m} --file plan.json), edit it, then: mp pm plan submit ${m} --file plan.json --words ${t.words.join(',') || 'W-<n>'}`,
      ];
      return ok(out !== null ? head.join('\n') : `${head.join('\n')}\n\n${json.trimEnd()}`, { mission: m, template: t.template, words: t.words, file: out });
    }
    if (sub !== 'submit') throw usage('plan takes submit or template');
    const m = missionArg(args, 1);
    const file = flagStr(args, 'file');
    if (file === null) throw usage('--file: the PM plan document (JSON)');
    let doc: unknown;
    try {
      doc = JSON.parse(readFileSync(file, 'utf8'));
    } catch (e) {
      throw usage(`cannot read the plan ${file}: ${(e as Error).message}`);
    }
    const words = flagList(args, 'words');
    if (words.length === 0) throw usage('--words W-<n>: the words entries this batch aligns (decision 1)');
    for (const w of words) if (!WORDS.test(w) || p.ctx.memory.read((db) => wordsEntry(db, w)) === null) throw refused('NO_WORDS', `there is no words entry ${w}`);
    const mode = flagStr(args, 'mode');
    if (mode !== null && mode !== 'stable' && mode !== 'fast') throw usage('--mode is stable or fast');
    let r: { readonly batch: string; readonly plan: string; readonly recheck?: boolean };
    try {
      r = await pmPlan(p.ctx, { mission: m, plan: doc, words, changedItems: flagList(args, 'changed'), dependentItems: flagList(args, 'dependent'), ...(mode !== null ? { mode } : {}) });
    } catch (e) {
      const name = (e as { name?: string }).name;
      if (name === 'LedgerError' || name === 'ProcessError') throw e;
      // the plan does not validate: say where, and where its format is
      const issues = name === 'ZodError' ? ((e as { issues?: Array<{ path: Array<string | number>; message: string }> }).issues ?? []).map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ') : (e as Error).message;
      throw refused('BAD_PLAN', `the PM plan does not validate: ${issues}. Its format, prefilled for this mission: mp pm plan template ${m}`);
    }
    if (r.recheck === true) {
      return ok(`The plan document is the plan in effect, unchanged: batch ${r.batch} re-checks ${r.plan} (no new version, no Architect). Calibrator ① judges it again on the requirement items as they are now (mp pm next); a current deciding pass restores its proof; dependents recover only while their own inputs remain current.`, { mission: m, batch: r.batch, plan: r.plan, recheck: true });
    }
    return ok(`PM plan batch ${r.batch} recorded (plan ${r.plan}); Calibrator ① checks it next (mp pm next). The Architect starts only after it passes.`, { mission: m, batch: r.batch, plan: r.plan });
  },
};

const OPTIONS = DECISION_OPTIONS.filter((o) => o !== 'ask-user');

const answer: Command = {
  group: 'pm',
  name: ['answer'],
  summary: 'the user\'s decision on an escalation waiting for them; carried out like a Secretary decision (WI-24)',
  usage: `mp pm answer <mission> <escalation> --option ${OPTIONS.join('|')} --words W-<n> [--instructions "<text>"] [--extra <n>]`,
  flags: { option: 'string', words: 'string', instructions: 'string', extra: 'string' },
  async run(c, args) {
    const p = P(c);
    const m = missionArg(args, 0);
    const esc = positional(args, 1, 'escalation');
    const option = flagStr(args, 'option');
    if (option === null || !OPTIONS.includes(option as Exclude<DecisionOption, 'ask-user'>)) throw usage(`--option is one of ${OPTIONS.join(', ')}`);
    const w = wordsArg(p.ctx, args, true)!;
    const extra = flagStr(args, 'extra');
    const n = extra === null ? undefined : Number(extra);
    if (n !== undefined && (!Number.isSafeInteger(n) || n < 1)) throw usage('--extra is a positive integer');
    const ins = flagStr(args, 'instructions');
    await pmAnswer(p.ctx, { mission: m, escalation: esc, option: option as DecisionOption, words: w, ...(ins !== null ? { instructions: ins } : {}), ...(n !== undefined ? { grantExtra: n } : {}) });
    return ok(`The user's answer to ${esc} recorded (${option}, ${w}); mp carries it out. Next: mp pm next`, { mission: m, escalation: esc, option, words: w });
  },
};

const grant: Command = {
  group: 'pm',
  name: ['grant'],
  summary: 'the user grants more attempts on an exhausted loop (after the Secretary\'s one grant, WI-08)',
  usage: `mp pm grant <lineage> <loop> --extra <n> --words W-<n> [--mission <mission>]   (loops: ${LOOP_KINDS.join(', ')})`,
  flags: { extra: 'string', words: 'string', mission: 'string' },
  async run(c, args) {
    const p = P(c);
    const lineage = positional(args, 0, 'lineage');
    const loop = positional(args, 1, 'loop');
    if (!(LOOP_KINDS as readonly string[]).includes(loop)) throw usage(`the loop is one of ${LOOP_KINDS.join(', ')}`);
    const n = Number(flagStr(args, 'extra') ?? '');
    if (!Number.isSafeInteger(n) || n < 1) throw usage('--extra is a positive integer');
    const w = wordsArg(p.ctx, args, true)!;
    const m = flagStr(args, 'mission');
    const r = await pmGrant(p.ctx, { lineage, loop: loop as LoopKind, extra: n, words: w, ...(m !== null ? { mission: m } : {}) });
    return ok(r.granted ? `Granted ${n} more attempt(s) on ${lineage} (${loop}).` : `Not granted: ${r.why ?? 'refused'}.`, { lineage, loop, extra: n, ...r }, r.granted ? 0 : EXIT.REFUSED);
  },
};

const legalize: Command = {
  group: 'pm',
  name: ['legalize'],
  summary: 'legalization the user asked for: compute the backfill plan, start it once they agree, or show it',
  usage: 'mp pm legalize request <mission> <endpoint> --words W-<n> [--id <legalization>] | mp pm legalize start <mission> <legalization> --words W-<n> | mp pm legalize show <mission> <legalization>',
  flags: { words: 'string', id: 'string' },
  decides: true,
  async run(c, args) {
    const p = P(c);
    const sub = positional(args, 0, 'request, start or show');
    const m = missionArg(args, 1);
    if (sub === 'show') {
      const l = positional(args, 2, 'legalization');
      const s = await pmLegalizationState(p.ctx, { mission: m, legalization: l });
      const state = s.request === null ? 'not requested' : s.result !== null ? `ended: ${s.result.outcome}${s.result.wi ? ` (${s.result.wi})` : ''} — ${s.result.why}` : s.started ? `running (${s.consumed.size} of ${s.tasks.size} Auditor tasks done)` : 'planned; waiting for the user to start it';
      return ok(`Legalization ${l}: ${state}`, { legalization: l, requested: s.request !== null, started: s.started, plan: s.plan, result: s.result, tasks: s.tasks.size, consumed: s.consumed.size });
    }
    const w = wordsArg(p.ctx, args, true)!;
    if (sub === 'request') {
      const endpoint = positional(args, 2, 'endpoint (an object version or proof unit)');
      const id = flagStr(args, 'id') ?? `leg-${sha256(`${m}\n${endpoint}\n${w}`).slice(0, 12)}`;
      const plan = (await pmLegalize(p.ctx, { legalization: id, mission: m, endpoint, words: `${wordsText(p.ctx, w)} (${w})`, chainEvidence: [], capabilities: [] })) as { chain: readonly string[]; pending: readonly string[]; seats: number; blocked: ReadonlyArray<{ id: string; label: string }> };
      if (plan.blocked.length > 0) {
        return ok([`Legalization ${id} of ${endpoint} cannot proceed: ${plan.blocked.map((b) => `${b.id} is ${b.label}`).join(', ')}.`, ...wiLine(p, 'WI-25')].join('\n'), { legalization: id, plan }, EXIT.REFUSED);
      }
      return ok(`Legalization ${id} of ${endpoint}: ${plan.pending.length} of ${plan.chain.length} nodes need a backfill; at most ${plan.seats} Auditor seats. Show the user; when they agree: mp pm legalize start ${m} ${id} --words W-<n>.`, { legalization: id, plan });
    }
    if (sub === 'start') {
      const l = positional(args, 2, 'legalization');
      await pmStartLegalization(p.ctx, { mission: m, legalization: l, words: w });
      return ok(`Legalization ${l} started; its Auditor steps appear in mp pm next.`, { legalization: l, started: true });
    }
    throw usage('legalize takes request, start or show');
  },
};

// ---------------------------------------------------------------- delivery, landing, closing

function target(s: string): DeliveryTarget {
  if (s.startsWith('unit:')) return { kind: 'unit', id: s.slice(5) as ProofUnitId };
  return { kind: 'object', id: s.replace(/^object:/, '') as ObjectVersionId };
}

export function renderDelivery(p: Project, r: DeliveryResult): { text: string; exitCode: number; wi: string | null } {
  const R = EXIT.REFUSED;
  const withWi = (head: string, wi: string | null): { text: string; exitCode: number; wi: string | null } => ({ text: [head, ...wiLine(p, wi)].join('\n'), exitCode: R, wi });
  switch (r.kind) {
    case 'delivered': {
      const notProven = r.record.proof?.notFullyProven ?? [];
      return {
        text: [
          `Delivery ${r.record.delivery} made: ref ${r.record.ref} at ${short(r.record.commit)} on base ${short(r.record.base)}${r.recovered ? ' (finished an earlier attempt)' : ''}.`,
          ...(notProven.length > 0 ? [`Delivered with their labels, not fully proven: ${notProven.map((n) => n.id).join(', ')}.`] : []),
          `No command ran: ${r.record.fullRun?.line ?? 'full-run status not recorded (a delivery made before 4.1.2)'}. A full run at the end is your call (D-7).`,
        ].join('\n'),
        exitCode: 0,
        wi: null,
      };
    }
    case 'candidate':
      return { text: `Candidate ${short(r.commit)} (tree ${short(r.tree)}) on base ${short(r.base)} built and proof-checked; nothing was delivered.`, exitCode: 0, wi: null };
    case 'recomputing':
      return { text: 'The labels are recomputing: nothing was built. Run the same command again shortly (if it lasts, WI-32: mp pm drain).', exitCode: R, wi: null };
    case 'unknown-targets':
      return withWi(`The outputs name objects the memory does not know: ${r.missing.map((t) => t.id).join(', ')}.`, 'WI-20');
    case 'unplaced-products':
      return withWi(`These versions have no commit and cannot be delivered: ${r.versions.join(', ')}.`, 'WI-20');
    case 'incompatible':
      return { text: `The manifest is incompatible (${r.conflicts.length} path(s) in different versions): an integration task is needed (a PM plan batch that asks for it), then deliver again.`, exitCode: R, wi: null };
    case 'conflict':
      return { text: `${r.conflicts.length} conflict(s) on base ${short(r.base)}: an integration task resolves them and a Reviewer accepts it; then deliver again.`, exitCode: R, wi: null };
    case 'description-mismatch':
      return withWi(`These versions were accepted under another transform description: ${r.versions.join(', ')}.`, 'WI-19');
    case 'objects-unavailable':
      return withWi(`Git objects the candidate needs are not here (${r.code}): ${[...r.objects, ...r.paths].slice(0, 10).join(', ')}; nothing was fetched.`, 'WI-13');
    case 'rebuild-limit-exhausted':
      return withWi(`This delivery's rebuilds are used up (${r.rebuilds}/${r.limit}): ${r.detail}${r.leftRef !== null ? `; the delivery ref ${r.leftRef} stays` : ''}.`, 'WI-08');
    case 'ref-mismatch':
      return withWi(`The delivery ref ${r.ref} exists and points elsewhere (${short(r.found)}); it is never overwritten: deliver again under a new id (--op <new id>).`, 'WI-20');
    case 'ref-pending':
      return { text: `The delivery ref ${r.ref} is not there yet (${r.detail}); the intent stays open. Run the same command again: it reissues the same create-only update.`, exitCode: R, wi: null };
  }
}

/** The mission of a delivery id (unique across missions, or named with --mission). */
function deliveryMission(ctx: ProcessContext, delivery: string, flag: string | null): string {
  if (flag !== null) return flag;
  const ms = ctx.memory.read((db) => (db.stmt('SELECT mission FROM deliveries WHERE delivery = ?').all(delivery) as Array<{ mission: string }>).map((r) => r.mission));
  if (ms.length === 0) throw refused('NO_DELIVERY', `there is no delivery ${delivery} (mp read status lists them)`);
  if (ms.length > 1) throw usage(`delivery ${delivery} exists in several missions (${ms.join(', ')}): give --mission`);
  return ms[0]!;
}

/** `--message "<subject>"`: one line, the delivery commit's subject. */
function messageArg(args: ParsedArgs): string | null {
  const m = flagStr(args, 'message');
  if (m === null) return null;
  const t = m.trim();
  if (t === '' || /[\r\n]/.test(t) || t.length > 500) throw usage('--message is the delivery commit\'s subject: one line, 1 to 500 characters');
  return t;
}

const deliver: Command = {
  group: 'pm',
  name: ['deliver'],
  summary: 'deliver: the manifest, the candidate on the target branch, its proof check and full-run status, the delivery ref (§6.7); no command runs',
  usage: 'mp pm deliver <mission> --outputs <object|unit:<id>,...> --words W-<n> [--message "<commit subject>"] [--rebuild-of <delivery>] [--op <delivery id>]',
  flags: { outputs: 'list', words: 'string', 'rebuild-of': 'string', message: 'string' },
  decides: true,
  async run(c, args) {
    const p = P(c);
    const m = missionArg(args, 0);
    const outputs = flagList(args, 'outputs');
    if (outputs.length === 0) throw usage('--outputs: what the user wants delivered (object versions, or unit:<proof unit>)');
    const w = wordsArg(p.ctx, args, true)!;
    const message = messageArg(args);
    // the delivery's id: --op when given (deliver again under a new id), else one derived from the request, so a retry finishes the same delivery
    const delivery = flagStr(args, 'op') ?? deliveryIdFor(m, outputs.map(target), w, message);
    if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/.test(delivery)) throw usage(`a delivery id (--op) is letters, digits and "-", at most 64: ${delivery}`);
    const rebuildOf = flagStr(args, 'rebuild-of');
    const r = await pmDeliver(p.ctx, { mission: m, delivery, selected: outputs.map(target), words: w, ...(rebuildOf !== null ? { rebuildOf } : {}), ...(message !== null ? { message } : {}) });
    const d = renderDelivery(p, r);
    const nextLine = r.kind === 'delivered' ? `\nThe user's "deliver" is consent to land: mp pm land ${delivery} --words ${w}` : '';
    return ok(`${d.text}${nextLine}`, { mission: m, delivery, result: r, wi: d.wi }, d.exitCode);
  },
};

const fullRun: Command = {
  group: 'pm',
  name: ['full-run'],
  summary: "D-7: run the full suite once more at the end of a mission, on the candidate mp pm deliver would build; the user's words or an authorization in force decide it, recorded with a full-run marker",
  usage: 'mp pm full-run <mission> --words W-<n> | --authority <item-id>  --reason "<why the changes since the last full run are worth another>" [--outputs <object|unit:<id>,...>]',
  flags: { words: 'string', authority: 'string', reason: 'string', outputs: 'list' },
  decides: true,
  async run(c, args) {
    const p = P(c);
    const m = missionArg(args, 0);
    const w = wordsArg(p.ctx, args, false);
    const authority = flagStr(args, 'authority');
    if (w === null && authority === null) throw refused('NO_DECISION', 'a full run at the end of a mission needs who decided it: --words W-<n> (the user agreed, after the PM reported the reason) or --authority <item-id> (an authorization item in force that leaves this to the PM); nothing was run');
    const reason = flagStr(args, 'reason');
    if (reason === null || reason.trim() === '') throw usage('--reason "<text>": why the changes since the last full run are worth another one');
    const outputs = flagList(args, 'outputs');
    const r = await pmFullRun(p.ctx, { mission: m, words: w, authority, reason, ...(outputs.length > 0 ? { outputs: outputs.map(target) } : {}) });
    const lines = [
      `Candidate ${short(r.candidate)} (what mp pm deliver would build for ${r.outputs.join(', ')}; nothing was delivered).`,
      ...fullRunLines(r.marker),
      ...r.marker.failing.flatMap((f) => [`--- last lines of ${f.id}:`, f.tail]),
      r.marker.passed ? 'Report the result to the user; a delivery of the same tree shows this run (mp pm deliver, mp pm finish): nothing runs again.' : 'It failed (WI-21): trace the failure to its task (mp read full-runs, the run summary), report to the user, and repair that task (mp pm repair) or merge on their words.',
    ];
    return ok(lines.join('\n'), { mission: m, ...r }, r.marker.passed ? 0 : EXIT.REFUSED);
  },
};

const reopenExploration: Command = {
  group: 'pm',
  name: ['reopen-exploration'],
  summary: 'after an environment change: reopen a settled exploration so its evidence executions run again under this environment and the attacker re-checks the version (it is never reopened by itself)',
  usage: 'mp pm reopen-exploration <mission> <exploration> [--words W-<n>]',
  flags: { words: 'string' },
  decides: true,
  async run(c, args) {
    const p = P(c);
    const m = missionArg(args, 0);
    const x = positional(args, 1, 'exploration');
    const w = wordsArg(p.ctx, args, false);
    const r = await pmReopenExploration(p.ctx, { mission: m, exploration: x, words: w });
    return ok(r.requested ? `Exploration ${x} of ${m} is reopened under environment ${short(r.environment)} (if its executions ran in an older one): mp pm next lists the reruns.` : `Exploration ${x} of ${m} was already reopened under this environment: nothing new.`, { mission: m, exploration: x, ...r });
  },
};

const resnapshotExploration: Command = {
  group: 'pm',
  name: ['resnapshot-exploration'],
  summary: 'a started exploration reads the target branch as it is now (code that landed after it began): its next cards name the new snapshot; nothing runs again by itself, and evidence recorded before still counts, marked "older environment"',
  usage: 'mp pm resnapshot-exploration <mission> <exploration> --words W-<n>',
  flags: { words: 'string' },
  decides: true,
  async run(c, args) {
    const p = P(c);
    const m = missionArg(args, 0);
    const x = positional(args, 1, 'exploration');
    const w = wordsArg(p.ctx, args, true);
    const r = await pmResnapshotExploration(p.ctx, { mission: m, exploration: x, words: w });
    return ok(
      `Exploration ${x} of ${m} now reads ${short(r.snapshot)} (it read ${short(r.previous)}): every card dispatched from now on names it. Nothing runs again by itself; ${r.olderEvidence.length} evidence execution(s) recorded before still count, marked "older environment".`,
      { mission: m, exploration: x, ...r },
    );
  },
};

function renderLanding(p: Project, r: LandingResult): { text: string; exitCode: number; wi: string | null } {
  switch (r.kind) {
    case 'landed': {
      const wt = r.worktree !== null && r.worktree.relation !== 'consistent';
      return {
        text: [`Landed: ${r.branch} moved ${short(r.base)} → ${short(r.commit)} (${r.via}).${r.startedBeforeStop ? ' It had started before a stop that now covers it.' : ''}`, ...(wt ? [`The worktree ${r.worktree!.root} does not match the delivery: ${r.worktree!.detail}${r.worktree!.command !== null ? ` (${r.worktree!.command})` : ''}`, ...wiLine(p, 'WI-04')] : [])].join('\n'),
        exitCode: 0,
        wi: wt ? 'WI-04' : null,
      };
    }
    case 'in-progress':
      return { text: ['A landing is in progress (another mp holds the landing lock): nothing was touched. Wait, then mp read status.', ...wiLine(p, 'WI-06')].join('\n'), exitCode: EXIT.BUSY, wi: 'WI-06' };
    case 'base-moved':
      return { text: `The target branch ${r.branch} is no longer at the delivery's base ${short(r.base)} (now ${short(r.now)}): nothing was landed or merged.`, exitCode: EXIT.REFUSED, wi: 'WI-05' };
    case 'not-landed':
      return { text: [`Not landed (${r.reason}): ${r.detail}${r.paths.length > 0 ? ` (${r.paths.slice(0, 10).join(', ')})` : ''}. The delivery ref is kept.`, ...wiLine(p, r.wi)].join('\n'), exitCode: EXIT.REFUSED, wi: r.wi };
    case 'open':
      return { text: [`The landing intent ${r.intent} is open (class ${r.class}): ${r.detail}; ${r.branch} is at ${short(r.ref)} (base ${short(r.base)}, delivery ${short(r.commit)})${r.lockFiles.length > 0 ? `; git lock files: ${r.lockFiles.join(', ')}` : ''}.`, ...wiLine(p, 'WI-06')].join('\n'), exitCode: EXIT.REFUSED, wi: 'WI-06' };
    case 'refused':
      return { text: [`Refused (${r.reason}): ${r.detail}.`, ...wiLine(p, 'WI-06')].join('\n'), exitCode: EXIT.REFUSED, wi: 'WI-06' };
  }
}

/** A landing that found the base moved, with its WI-05 default rebuild (one place for `land` and `finish`). */
function renderRebuilt(p: Project, landing: string, rb: DeliveryResult, w: string, then: readonly string[] = []): { lines: string[]; exitCode: number } {
  const rd = renderDelivery(p, rb);
  return {
    lines: [landing, `Rebuilt on the new base (WI-05 default): ${rd.text}`, ...(rb.kind === 'delivered' ? [`Next: mp pm land ${rb.record.delivery} --words ${w}`, ...then] : []), ...wiLine(p, 'WI-05')],
    exitCode: rb.kind === 'delivered' ? EXIT.REFUSED : rd.exitCode,
  };
}

const land: Command = {
  group: 'pm',
  name: ['land'],
  summary: 'land a delivery: fast-forward from its recorded base only, never a merge (§6.7); or close an open intent as not landed, or deliver the ref only',
  usage: 'mp pm land <delivery> --words W-<n> [--allow-external <worktree>] [--mission <mission>] | mp pm land <delivery> --close-not-landed | mp pm land <delivery> --deliver-ref-only',
  flags: { words: 'string', 'allow-external': 'string', mission: 'string', 'close-not-landed': 'boolean', 'deliver-ref-only': 'boolean' },
  decides: true,
  async run(c, args) {
    const p = P(c);
    const delivery = positional(args, 0, 'delivery');
    const m = deliveryMission(p.ctx, delivery, flagStr(args, 'mission'));
    const info = p.ctx.memory.read((db) => deliveryInfo(db, m as MissionId, delivery));
    if (info === null) throw refused('NO_DELIVERY', `mission ${m} has no delivery ${delivery}`);
    if (flagBool(args, 'deliver-ref-only')) {
      const cmds = [`git fetch . ${info.ref}`, `git merge ${info.ref}    # in a worktree of ${info.target ?? p.ctx.targetBranch}, by the user or an agent`];
      return ok([`Recorded: delivery ${delivery} is delivered as a ref only; no automatic landing (mp read status shows "delivered, not landed").`, `Delivery ref: ${info.ref} (commit ${short(info.commit)})`, 'To merge it:', ...cmds.map((x) => `  ${x}`)].join('\n'), { mission: m, delivery, refOnly: true, ref: info.ref, commit: info.commit });
    }
    if (flagBool(args, 'close-not-landed')) {
      const r = await closeNotLanded(p.ctx.gitCtx, { mission: m as MissionId, delivery, filler: p.ctx.filler });
      const text =
        r.kind === 'closed'
          ? `The landing intent ${r.intent} is closed as not landed (the branch is at ${short(r.ref)}); the delivery ref stays. A later landing starts a new intent.`
          : r.kind === 'landed'
            ? `The fresh check found the branch at the delivery commit: recorded as landed instead.`
            : r.kind === 'in-progress'
              ? 'A landing is in progress: nothing was closed. Wait, then try again.'
              : 'No landing intent of this delivery is open.';
      return ok(text, { mission: m, delivery, result: r }, r.kind === 'in-progress' ? EXIT.BUSY : 0);
    }
    const w = wordsArg(p.ctx, args, true)!;
    const ext = flagStr(args, 'allow-external');
    const r = await pmLand(p.ctx, { mission: m, delivery, words: w, ...(ext !== null ? { allowExternal: ext } : {}) });
    const d = renderLanding(p, r);
    if (r.kind !== 'base-moved') return ok(d.text, { mission: m, delivery, result: r, intent: r.kind === 'landed' || r.kind === 'open' ? r.intent : null, wi: d.wi }, d.exitCode);
    // WI-05 default: rebuild the candidate on the new base (counted), then the PM lands the new delivery
    const rb = await pmRebuild(p.ctx, { mission: m, delivery });
    const x = renderRebuilt(p, d.text, rb, w);
    return ok(x.lines.join('\n'), { mission: m, delivery, result: r, rebuild: rb, wi: 'WI-05' }, x.exitCode);
  },
};

const withdrawDeliveryCmd: Command = {
  group: 'pm',
  name: ['withdraw-delivery'],
  summary: 'the user withdrew a delivery: it is never landed or delivered again (its ref stays)',
  usage: 'mp pm withdraw-delivery <delivery> --words W-<n> [--mission <mission>]',
  flags: { words: 'string', mission: 'string' },
  async run(c, args) {
    const p = P(c);
    const delivery = positional(args, 0, 'delivery');
    const m = deliveryMission(p.ctx, delivery, flagStr(args, 'mission'));
    const w = wordsArg(p.ctx, args, true)!;
    const reason = `${wordsText(p.ctx, w)} (${w})`.slice(0, 4000);
    const r = p.ctx.memory.write({ op: `withdraw-delivery:${m}:${delivery}`, payload: { reason }, command: 'withdraw-delivery', filler: p.ctx.filler }, (tx) => withdrawDelivery(tx, { mission: m as MissionId, delivery, reason }));
    return ok(r.revision === null ? `Delivery ${delivery} was already withdrawn.` : `Delivery ${delivery} withdrawn: it is never landed or delivered again; its ref stays.`, { mission: m, delivery, withdrawn: true });
  },
};

const detachDuplicate: Command = {
  group: 'pm',
  name: ['detach-duplicate'],
  summary: 'WI-01 option 2: detach an abandoned duplicate checkout of the target branch (HEAD stays at the same commit; nothing is deleted)',
  usage: 'mp pm detach-duplicate <worktree>',
  flags: {},
  async run(c, args) {
    const p = P(c);
    const wt = positional(args, 0, 'worktree');
    const r = await detachDuplicateCheckout({ memory: p.ctx.memory, git: p.ctx.git }, { repoPath: p.dir, worktree: wt, targetBranch: p.ctx.targetBranch });
    if (r.kind === 'refused') return ok(`Nothing changed: ${r.reason}`, r, EXIT.REFUSED);
    return ok(`${r.worktree} is detached at ${short(r.commit)} (no longer holding ${r.branch}); index and files unchanged, nothing deleted. Undo: ${r.undo}.`, r);
  },
};

const close: Command = {
  group: 'pm',
  name: ['close'],
  summary: 'close a mission: the honest closing snapshot (what is delivered, unproven, unfinished, at risk); never refused on the state of the work (D-11). Production steps are held; audits and deliveries go on',
  usage: 'mp pm close <mission> [--words W-<n>] [--mode with-risk|full|post-audit]   (the mode is only recorded; default with-risk)',
  flags: { mode: 'string', words: 'string' },
  decides: true,
  async run(c, args) {
    const p = P(c);
    const m = missionArg(args, 0);
    const mode = flagStr(args, 'mode') ?? 'with-risk';
    if (mode !== 'with-risk' && mode !== 'full' && mode !== 'post-audit') throw usage('--mode is with-risk, full or post-audit');
    const w = wordsArg(p.ctx, args, false);
    // the process layer writes the snapshot inside the close's own write; it refuses nothing about the work
    const r = await pmClose(p.ctx, m, { mode, request: c.op, words: w });
    return ok(r.message, r);
  },
};

const finish: Command = {
  group: 'pm',
  name: ['finish'],
  summary: 'the user\'s "close and merge" in one step (D-9): deliver the accepted outputs, land, close, all on the same words; stops after the delivery, mission open, when landing cannot complete',
  usage: 'mp pm finish <mission> --words W-<n> [--outputs <object|unit:<id>,...>] [--message "<commit subject>"] [--allow-external <worktree>]',
  flags: { words: 'string', outputs: 'list', message: 'string', 'allow-external': 'string' },
  decides: true,
  async run(c, args) {
    const p = P(c);
    const m = missionArg(args, 0);
    const w = wordsArg(p.ctx, args, true)!;
    const message = messageArg(args);
    const given = flagList(args, 'outputs');
    const ext = flagStr(args, 'allow-external');
    const r = await pmFinish(p.ctx, { mission: m, words: w, outputs: given.length > 0 ? given.map(target) : null, message, request: c.op, ...(ext !== null ? { allowExternal: ext } : {}) });
    const lines: string[] = [];
    let exitCode = 0;
    let wi: string | null = null;
    if (r.delivery === null) lines.push(`Nothing to deliver: the plan in effect of ${m} has no accepted output. Nothing was landed.`);
    else {
      const d = renderDelivery(p, r.delivery.result);
      lines.push(`1. Deliver (${r.outputs.map(targetKey).join(', ')}): ${d.text}`);
      if (r.stoppedAt === 'deliver') {
        exitCode = d.exitCode;
        wi = d.wi;
        lines.push(`Stopped after the delivery step: nothing was landed; mission ${m} stays open. When it is resolved: mp pm finish ${m} --words ${w} again (the same words).`);
      }
    }
    if (r.landing !== null) {
      const l = renderLanding(p, r.landing);
      if (r.landing.kind === 'base-moved' && r.rebuild !== null) {
        const x = renderRebuilt(p, l.text, r.rebuild, w, [`then: mp pm close ${m} --words ${w}`]);
        lines.push(`2. Land${r.landed !== r.delivery?.id ? ` (${r.landed})` : ''}: ${x.lines.join('\n')}`);
        exitCode = x.exitCode;
        wi = 'WI-05';
      } else {
        lines.push(`2. Land${r.landed !== r.delivery?.id ? ` (${r.landed})` : ''}: ${l.text}`);
        if (r.stoppedAt === 'land') {
          exitCode = l.exitCode;
          wi = l.wi;
        } else if (l.wi !== null) wi = l.wi;
      }
      if (r.stoppedAt === 'land') {
        const id = r.landed ?? '<delivery>';
        lines.push(`Stopped after the delivery: ${id} is delivered, not landed; mission ${m} stays open. Once the WI is resolved, the same words serve: mp pm land ${r.rebuild?.kind === 'delivered' ? r.rebuild.record.delivery : id} --words ${w}, then mp pm close ${m} --words ${w}.`);
      }
    }
    if (r.close !== null) lines.push(`${r.delivery === null ? '' : '3. Close: '}${r.close.message}`);
    return ok(lines.join('\n'), { mission: m, words: w, outputs: r.outputs, delivery: r.delivery, landed: r.landed, landing: r.landing, rebuild: r.rebuild, close: r.close, stoppedAt: r.stoppedAt, wi }, exitCode);
  },
};

// ---------------------------------------------------------------- notices, the copy, the chain

const alerts: Command = {
  group: 'pm',
  name: ['alerts'],
  summary: 'the notices not acknowledged; --ack <id,...> acknowledges them after you handled them',
  usage: 'mp pm alerts [--ack <id,...>] [--all]',
  flags: { ack: 'list', all: 'boolean' },
  async run(c, args) {
    const p = P(c);
    const ids = flagList(args, 'ack');
    if (ids.length > 0) {
      const r = pmAck(p.ctx, ids);
      return ok(`${r.acknowledged} notice(s) acknowledged.`, { acknowledged: r.acknowledged, ids });
    }
    const xs = p.ctx.memory.read((db) => listNotices(db, p.ctx.memory.data, { includeAcknowledged: flagBool(args, 'all') }));
    return ok(xs.length === 0 ? 'No notices.' : xs.map((n) => `[${n.state}] ${n.id}: ${clip(n.trigger, 200)}${n.wi !== null ? ` [${wiText(n.wi, p.dir)}]` : ''}`).join('\n'), { notices: xs });
  },
};

const ack: Command = {
  group: 'pm',
  name: ['ack'],
  summary: 'acknowledge notices you handled (the same as mp pm alerts --ack)',
  usage: 'mp pm ack <id> [<id>...]',
  flags: {},
  async run(c, args) {
    const p = P(c);
    if (args.positionals.length === 0) throw usage('the notice ids (mp pm next shows them)');
    const r = pmAck(p.ctx, args.positionals);
    return ok(`${r.acknowledged} notice(s) acknowledged.`, { acknowledged: r.acknowledged, ids: args.positionals });
  },
};

const confirmCopy: Command = {
  group: 'pm',
  name: ['confirm-copy'],
  summary: 'this copy of the folder is the one in use: git writes are allowed again (WI-31, decision 3)',
  usage: 'mp pm confirm-copy [--words W-<n>]',
  flags: { words: 'string' },
  async run(c, args) {
    const p = P(c);
    const w = wordsArg(p.ctx, args, false);
    const r = p.ctx.memory.confirmCopyInUse({ op: `confirm-copy:${c.op}`, words: w, filler: p.ctx.filler });
    return ok(r.released ? 'Confirmed: this copy is the one in use; git writes are allowed again. Do not use the other copy.' : 'Git writes were not held: nothing to confirm.', { released: r.released });
  },
};

const continueFrom: Command = {
  group: 'pm',
  name: ['continue-from'],
  summary: 'after a broken event chain: continue from the last valid event (WI-29, decision 4); what came after it is dropped',
  usage: 'mp pm continue-from <event>   (the last valid event mp read status names)',
  flags: {},
  unrecorded: true,
  async run(c, args) {
    const p = P(c);
    const ev = Number(positional(args, 0, 'event'));
    const st = p.ctx.memory.status();
    if (st.chainBroken === null) return ok('The event chain is not broken: nothing to do.', { continued: false });
    if (!Number.isSafeInteger(ev) || ev !== st.chainBroken.lastValid) throw refused('NOT_LAST_VALID', `the last valid event is ${st.chainBroken.lastValid}, not ${String(ev)}: name it to confirm`, 'WI-29');
    const r = p.ctx.memory.continueFromLastValid();
    return ok(`Continued from event ${r.lastValid}: the log was cut after event ${r.kept} (${r.removed} event(s) removed) and the state rebuilt. Redo what they recorded (say the user's words again, dispatch the steps again); then mp pm next.`, { continued: true, ...r });
  },
};

export const PM_COMMANDS: readonly Command[] = [
  session,
  say,
  next,
  dispatch,
  release,
  renew,
  drain,
  stop,
  stopNarrow,
  stopRelease,
  mission,
  requirement,
  repair,
  constraint,
  plan,
  answer,
  grant,
  legalize,
  deliver,
  fullRun,
  reopenExploration,
  resnapshotExploration,
  land,
  withdrawDeliveryCmd,
  detachDuplicate,
  close,
  clean,
  finish,
  alerts,
  ack,
  confirmCopy,
  continueFrom,
];

export type { CommandResult };
