// 4.4 (G6; the plan's F6): the commands of holds and of the disk. "Not this yet" is a hold: the PM places
// one on the user's words (`mp pm hold`), the Secretary for its own operational reasons with no words
// (`mp sec hold`); anyone reads them (`mp read holds`), and `mp read scratch` lists what takes the disk
// (process/holds.ts, process/scratchList.ts).

import { missionIdProblem } from '../../common/ids.ts';
import { readSteps } from '../../process/index.ts';
import { bytesText, endsText, holdViews, parseHoldTime, placeHold, releaseHold, subjectText, timeText, type HoldSubject, type HoldView } from '../../process/holds.ts';
import { scratchListing, type ScratchEntry } from '../../process/scratchList.ts';
import { flagBool, flagStr, positional, type ParsedArgs } from '../args.ts';
import { ok, type Command, type CommandResult, type RunContext } from '../command.ts';
import { CliError, EXIT, usage } from '../errors.ts';
import type { Project } from '../project.ts';
import { age, section } from '../render.ts';

const WORDS = /^W-[1-9][0-9]*$/;
/** A task, step or resource a hold names (the size of a record stays small). */
const NAME = /^[^\u0000-\u001f\u007f]{1,200}$/;
/** The held steps a placement names in its text (the JSON has all of them). */
const SHOWN = 20;

function P(c: RunContext): Project {
  if (c.project === null) throw new CliError('NOT_INITIALIZED', 'no project', { exitCode: EXIT.NO_PROJECT });
  return c.project;
}

/** The one subject a hold names. */
function subjectArg(a: ParsedArgs): HoldSubject {
  const task = flagStr(a, 'task');
  const step = flagStr(a, 'step');
  const resource = flagStr(a, 'resource');
  const all = flagBool(a, 'all');
  if ([task, step, resource].filter((x) => x !== null).length + (all ? 1 : 0) !== 1) throw usage('a hold names one subject: --task <id>, --step <id>, --resource <name> or --all');
  for (const [flag, v] of [['task', task], ['step', step], ['resource', resource], ['after', flagStr(a, 'after')]] as const) if (v !== null && !NAME.test(v)) throw usage(`--${flag} is 1 to 200 printable characters`);
  if (task !== null) return { kind: 'task', task };
  if (step !== null) return { kind: 'step', step };
  if (resource !== null) return { kind: 'resource', resource };
  return { kind: 'all' };
}

/** A hold's state in words. */
function stateText(v: Pick<HoldView, 'state' | 'note'>): string {
  return v.state === 'in-force' ? 'in force' : v.state === 'waiting' ? `not in force yet (${v.note})` : v.state === 'over' ? `over (${v.note})` : `released (${v.note})`;
}

function placedBy(v: Pick<HoldView, 'by' | 'words' | 'generation'>): string {
  return v.by === 'pm' ? `the PM${v.words !== null ? ` on ${v.words}` : ''}` : `the Secretary${v.generation !== null ? ` (${v.generation})` : ''}`;
}

async function holdRun(group: 'pm' | 'sec', c: RunContext, a: ParsedArgs): Promise<CommandResult> {
  const p = P(c);
  const sub = positional(a, 0, 'add|release');
  const words = group === 'pm' ? flagStr(a, 'words') : null;
  if (words !== null && !WORDS.test(words)) throw usage(`--words is a words entry W-<n>, not ${JSON.stringify(words)}`);
  if (sub === 'add') {
    const subject = subjectArg(a);
    const reason = flagStr(a, 'reason');
    if (reason === null || reason.trim() === '') throw usage('--reason "<why>": a hold says why');
    const mission = flagStr(a, 'mission');
    if (mission !== null && missionIdProblem(mission) !== null) throw usage(`--mission: ${missionIdProblem(mission)}`);
    for (const f of ['from', 'until']) {
      const v = flagStr(a, f);
      if (v !== null && parseHoldTime(v, p.ctx.now()) === null) throw usage(`--${f} is a time: an ISO date and time such as 2026-11-28T09:00Z (without a zone, local time), or +<n>m, +<n>h, +<n>d from now`);
    }
    const r = placeHold(p.ctx, { op: c.op!, subject, mission, after: flagStr(a, 'after'), from: flagStr(a, 'from'), until: flagStr(a, 'until'), reason, words });
    // its state and what it holds now, in one read after the write
    const { view, holdsNow } = p.ctx.memory.read((db) => ({
      view: holdViews(db, p.ctx.memory.data, p.ctx.now()).find((h) => h.id === r.hold)!,
      holdsNow: readSteps(p.ctx).held.filter((h) => h.holds?.some((x) => x.id === r.hold)).map((h) => `${h.step} (${h.kind})`),
    }));
    const lines = [
      r.repeated ? `Hold ${r.hold} was placed already with these arguments (${stateText(view)}): nothing new was recorded.` : `Hold ${r.hold} placed by ${placedBy(view)}: ${subjectText(view)}.`,
      `Reason: ${view.reason}`,
      `${view.state === 'in-force' ? 'In force now' : stateText(view).replace(/^./, (x) => x.toUpperCase())}.${view.state === 'in-force' || view.state === 'waiting' ? ` It ends when ${endsText({ hold: view.id, until: view.until, after: view.after }, group)}.` : ''}`,
      holdsNow.length > 0 ? `It holds now: ${holdsNow.slice(0, SHOWN).join(', ')}${holdsNow.length > SHOWN ? ` and ${holdsNow.length - SHOWN} more (mp read holds)` : ''}.` : 'It holds no queued step now.',
      'A hold blocks new dispatches only: dispatches in flight, hand-backs, runs, deliveries and landings go on.',
      ...r.warnings.map((w) => `Warning: ${w}.`),
    ];
    return ok(lines.join('\n'), { ...r, state: view.state, note: view.note, holdsNow });
  }
  if (sub === 'release') {
    const id = positional(a, 1, 'hold (H-<n>)');
    const r = releaseHold(p.ctx, { op: c.op!, hold: id, reason: flagStr(a, 'reason'), words });
    const lines = [r.released ? `Hold ${id} released by hand.` : `Hold ${id} was released before (by the ${r.releasedBy === 'pm' ? 'PM' : 'Secretary'}): nothing new was recorded.`, ...r.warnings.map((w) => `Warning: ${w}.`)];
    return ok(lines.join('\n'), r);
  }
  throw usage(`mp ${group} hold add|release`);
}

const TIME_NOTE = '(<time>: 2026-11-28T09:00Z, or +<n>m, +<n>h, +<n>d from now; --mission narrows a task, a resource or --all to one mission)';

const pmHold: Command = {
  group: 'pm',
  name: ['hold'],
  summary: '"not this yet", when the user said so: hold a task\'s Constructor steps, one queued step, a resource or everything; it blocks new dispatches only, until released by hand, at a time or when a task is accepted',
  usage: `mp pm hold add --task <id> | --step <id> | --resource <name> | --all [--mission <m>] [--after [<mission>/]<task>] [--from <time>] [--until <time>] --reason "<why>" --words W-<n>\n       mp pm hold release <H-n> [--reason "<why>"] [--words W-<n>]\n       ${TIME_NOTE}`,
  flags: { task: 'string', step: 'string', resource: 'string', all: 'boolean', mission: 'string', after: 'string', from: 'string', until: 'string', reason: 'string', words: 'string' },
  run: (c, a) => holdRun('pm', c, a),
};

const secHold: Command = {
  group: 'sec',
  name: ['hold'],
  summary: 'hold work for an operational reason (the order of work within the plan is yours), with no words: a task\'s Constructor steps, one queued step, a resource or everything; it blocks new dispatches only',
  usage: `mp sec hold add --task <id> | --step <id> | --resource <name> | --all [--mission <m>] [--after [<mission>/]<task>] [--from <time>] [--until <time>] --reason "<why>"\n       mp sec hold release <H-n> [--reason "<why>"]\n       ${TIME_NOTE}`,
  flags: { task: 'string', step: 'string', resource: 'string', all: 'boolean', mission: 'string', after: 'string', from: 'string', until: 'string', reason: 'string' },
  run: (c, a) => holdRun('sec', c, a),
};

const readHolds: Command = {
  group: 'read',
  name: ['holds'],
  summary: 'the holds in force or waiting for their time, each with what it names, who placed it and why, how it ends and the queued steps it holds now (--all: the released and the over ones too)',
  usage: 'mp read holds [--all]',
  flags: { all: 'boolean' },
  async run(c, a) {
    const p = P(c);
    const now = p.ctx.now();
    // the holds and the steps they hold, in one read
    const { views, held } = p.ctx.memory.read((db) => ({ views: holdViews(db, p.ctx.memory.data, now), held: readSteps(p.ctx).held }));
    const all = views.map((v) => ({ ...v, holdsNow: held.filter((h) => h.holds?.some((x) => x.id === v.id)).map((h) => `${h.step} (${h.kind})`) }));
    const open = all.filter((v) => v.state === 'in-force' || v.state === 'waiting');
    const shown = flagBool(a, 'all') ? all : open;
    const lines = shown.flatMap((v) => [
      `[${v.id}] ${stateText(v)}: ${subjectText(v)}; placed by ${placedBy(v)} at ${timeText(v.placedAt)}: ${v.reason}`,
      ...(v.state === 'in-force' || v.state === 'waiting' ? [`    ends when ${endsText({ hold: v.id, until: v.until, after: v.after }, p.ctx.secretary !== null ? 'sec' : 'pm')}${v.from !== null && v.state === 'in-force' ? ` (in force since ${timeText(v.from)})` : ''}`, `    holds now: ${v.holdsNow.join(', ') || 'no queued step'}`] : []),
    ]);
    const rest = all.length - open.length;
    const head = open.length === 0 ? 'No hold is in force or waiting for its time.' : `Holds in force or waiting: ${open.length}`;
    const text = [head, ...lines, ...(rest > 0 && !flagBool(a, 'all') ? [`${rest} released or over: mp read holds --all`] : [])].join('\n');
    return ok(text, { holds: shown });
  },
};

const KIND_TITLE: Readonly<Record<ScratchEntry['kind'], string>> = {
  worktree: 'Worktrees under .mission-pipeline/worktrees',
  checkout: 'Shared checkouts under .mission-pipeline/tmp/checkouts',
  scratch: 'Scratch folders under .mission-pipeline/tmp',
};

const readScratch: Command = {
  group: 'read',
  name: ['scratch'],
  summary: 'what takes the disk under .mission-pipeline/: the worktrees, shared checkouts and scratch folders with size, owner and age, the free disk and the limits of config.json; removes nothing (mp pm clean does)',
  usage: 'mp read scratch',
  flags: {},
  async run(c) {
    const r = scratchListing(P(c).ctx);
    const kinds: ReadonlyArray<ScratchEntry['kind']> = ['worktree', 'checkout', 'scratch'];
    const l = r.limits;
    const limits = l.worktrees === undefined && l.freeBytes === undefined ? 'none set' : `${[l.worktrees !== undefined ? `worktrees ${l.worktrees}` : '', l.freeBytes !== undefined ? `freeBytes ${bytesText(l.freeBytes)}` : ''].filter((x) => x !== '').join(', ')}; ${r.passed === null ? 'none is passed' : r.passed}`;
    const lines = [
      ...kinds.flatMap((k) => section(`${KIND_TITLE[k]} (${r.totals[k].count}, ${bytesText(r.totals[k].bytes)})`, r.entries.filter((e) => e.kind === k).map((e) => `${e.path}: ${bytesText(e.bytes)}, ${e.owner}${e.ageMs !== null ? `, ${age(e.ageMs)} old` : ''}`), 'none')),
      `Free on the project's disk: ${r.freeBytes === null ? 'cannot be read' : bytesText(r.freeBytes)}`,
      `Disk limits (config.json limits): ${limits}`,
    ];
    return ok(lines.join('\n'), r);
  },
};

export const HOLD_COMMANDS: readonly Command[] = [pmHold, secHold, readHolds, readScratch];
