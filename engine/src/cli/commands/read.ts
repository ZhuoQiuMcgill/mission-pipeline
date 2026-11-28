// `mp read …`: the layered reads and the tree reads (design 4.1 §8). Reads change nothing except
// "since the maintainer last asked" (`mp read status` moves it, unless --no-mark).

import { generations, liveSecretary } from '../../memory/resident.ts';
import { taggedWords } from '../../memory/words.ts';
import { flagBool, flagStr, positional } from '../args.ts';
import { ok, type Command, type RunContext } from '../command.ts';
import { CliError, EXIT, refused, usage } from '../errors.ts';
import type { Project } from '../project.ts';
import { markAsked, readStatus, SHOW_KINDS, showItem, statusText } from '../status.ts';
import { entryLines, resolveSubtasks } from '../layers.ts';
import { buildGraph, chain, resolveNodes, tree, walk } from '../tree.ts';
import { fullRunMarkers } from '../../process/index.ts';
import { fullRunLines } from './seat.ts';
import { pmNotes } from '../../process/secretary.ts';
import { constraintsRead, constraintsText, repairsRead, repairsText } from '../workReads.ts';
import { closureText, listAllItems, type RiskItemView } from '../../process/openItems.ts';
import { beforeText, notRecordedByTask } from '../../flow/riskItems.ts';
import { itemStateLines, readItems } from '../itemsRead.ts';
import { age } from '../render.ts';
import { reviewHealth, reviewRows, sharesLine } from '../../process/reviews.ts';

function P(c: RunContext): Project {
  if (c.project === null) throw new CliError('NOT_INITIALIZED', 'no project', { exitCode: EXIT.NO_PROJECT });
  return c.project;
}

const status: Command = {
  group: 'read',
  name: ['status'],
  summary: '"how is it going?": layer 0 (with the count of blocked subtasks) plus the layer-1 entries of the subtasks whose state changed since the user last asked; then marks this ask',
  usage: 'mp read status [--no-mark]   (--no-mark: keep "since the user last asked" where it is)',
  flags: { 'no-mark': 'boolean' },
  decides: true,
  async run(c, args) {
    const p = P(c);
    const s = await readStatus(p);
    if (!flagBool(args, 'no-mark')) markAsked(p.ctx, s.asOf);
    return ok(statusText(s), s);
  },
};

const blocked: Command = {
  group: 'read',
  name: ['blocked'],
  summary: '"why is it not done?": the layer-1 entry of every blocked subtask, each with its block reason and next step',
  usage: 'mp read blocked',
  flags: {},
  decides: true,
  async run(c) {
    const p = P(c);
    const r = await resolveSubtasks(p.ctx);
    const xs = r.blocked;
    const project = r.recomputing === null ? [] : [`Project: ${r.recomputing.because} / next: ${r.recomputing.next}${r.recomputing.wi !== null ? ` [${r.recomputing.wi}]` : ''}`];
    const text = xs.length === 0 ? ['Nothing is blocked: every subtask is progressing, finished, or waiting for its own next step (mp pm next).', ...project].join('\n') : [`Blocked: ${xs.length}`, ...xs.flatMap((e) => entryLines(e).map((x) => `  ${x}`)), ...project].join('\n');
    return ok(text, { blocked: xs, recomputing: r.recomputing });
  },
};

const showCmd: Command = {
  group: 'read',
  name: ['show'],
  summary: 'layers 1-2: one item with its state, checks, links and leaf paths',
  usage: `mp read show <kind> <id>   (kinds: ${SHOW_KINDS.join(', ')})\n       mp read show evidence|dispatch <id> --check-data   (hash the data outside the commit it cites again: unchanged, changed or missing; writes nothing)`,
  flags: { 'check-data': 'boolean' },
  async run(c, args) {
    const kind = positional(args, 0, 'kind');
    if (!SHOW_KINDS.includes(kind)) throw usage(`the kind is one of ${SHOW_KINDS.join(', ')}`);
    const id = positional(args, 1, 'id');
    const checkData = flagBool(args, 'check-data');
    if (checkData && kind !== 'evidence' && kind !== 'dispatch') throw usage('--check-data goes with mp read show evidence <id> or mp read show dispatch <id>');
    const r = await showItem(P(c), kind, id, { checkData });
    if (r === null) throw refused('NOT_FOUND', `no ${kind} ${id} in this memory`);
    return ok(r.text, r.json);
  },
};

const leaf: Command = {
  group: 'read',
  name: ['leaf'],
  summary: 'layer 3: a leaf\'s text, with its hash checked (a leaf id or path, or an item whose leaves to show)',
  usage: 'mp read leaf <leaf id | path | item id>',
  flags: {},
  async run(c, args) {
    const p = P(c);
    const raw = positional(args, 0, 'leaf');
    const id = raw.replace(/\\/g, '/').replace(/^\.\/?/, '').replace(/^\.mission-pipeline\//, '');
    let leaves = [id];
    if (p.ctx.memory.readLeaf(id) === null) {
      const g = buildGraph(p.ctx);
      leaves = resolveNodes(g, p.ctx, raw).flatMap((n) => n.leaves);
      if (leaves.length === 0) throw refused('NOT_FOUND', `no recorded leaf ${raw} (mp read show <kind> <id> lists an item's leaves)`);
    }
    const out: string[] = [];
    const json: unknown[] = [];
    let damaged = false;
    for (const l of leaves) {
      const r = p.ctx.memory.readLeaf(l);
      if (r === null) continue;
      const status = r.status === 'ok' ? 'hash checked' : r.status === 'missing' ? 'LEAF MISSING' : 'EDITED AFTER IT WAS RECORDED';
      if (r.status !== 'ok') damaged = true;
      out.push(`=== .mission-pipeline/${r.file}${r.anchor !== null ? `#${r.anchor}` : ''} (${status})`, r.text ?? '(missing)');
      json.push({ leaf: l, file: r.file, anchor: r.anchor, status: r.status, text: r.text });
    }
    if (damaged) out.push('A missing or edited leaf: only the steps that need it are held (WI-30).');
    return ok(out.join('\n'), { leaves: json }, 0);
  },
};

const why: Command = {
  group: 'read',
  name: ['why'],
  summary: 'walk back from any node (a commit, run, judgment, task, dispatch, decision, delivery) to the user\'s words: who handed each step over, its state, checks and leaf',
  usage: 'mp read why <id>   (an id of any item, a requirement line, a commit or a branch)',
  flags: {},
  async run(c, args) {
    const p = P(c);
    const raw = positional(args, 0, 'id');
    const g = buildGraph(p.ctx);
    const starts = resolveNodes(g, p.ctx, raw);
    if (starts.length === 0) throw refused('NOT_FOUND', `nothing in this memory is ${raw}`);
    const w = walk(p.ctx, g, starts, 'back');
    return ok(w.text, w.json);
  },
};

const from: Command = {
  group: 'read',
  name: ['from'],
  summary: 'walk forward: everything that rests on a node (what a withdrawn requirement or a refuted version affects); from a words entry W-n, also the constraints, waivers and notes that cite it',
  usage: 'mp read from <id>',
  flags: {},
  async run(c, args) {
    const p = P(c);
    const raw = positional(args, 0, 'id');
    const g = buildGraph(p.ctx);
    const starts = resolveNodes(g, p.ctx, raw);
    if (starts.length === 0) throw refused('NOT_FOUND', `nothing in this memory is ${raw}`);
    const w = walk(p.ctx, g, starts, 'forward');
    return ok(w.text, w.json);
  },
};

const chainCmd: Command = {
  group: 'read',
  name: ['chain'],
  summary: 'one dispatch: its card, the step that handed it over, its report, its checks and what it led to',
  usage: 'mp read chain <dispatch>',
  flags: {},
  async run(c, args) {
    const p = P(c);
    const d = positional(args, 0, 'dispatch');
    const g = buildGraph(p.ctx);
    const r = chain(p.ctx, g, d);
    if (r === null) throw refused('NOT_FOUND', `there is no dispatch ${d}`);
    return ok(r.text, r.json);
  },
};

const treeCmd: Command = {
  group: 'read',
  name: ['tree'],
  summary: 'a whole mission as one indented tree: words → requirements → plans → tasks → dispatches → candidates → judgments → deliveries',
  usage: 'mp read tree <mission>',
  flags: {},
  async run(c, args) {
    const p = P(c);
    const m = positional(args, 0, 'mission');
    const g = buildGraph(p.ctx, { mission: m });
    if (![...g.nodes.values()].some((n) => n.mission === m)) throw refused('NOT_FOUND', `mission ${m} has nothing recorded`);
    const t = tree(p.ctx, g, m);
    return ok(t.text, t.json);
  },
};

const fullRuns: Command = {
  group: 'read',
  name: ['full-runs'],
  summary: "a mission's full-run markers, newest first: when each full suite ran, on which commit and tree, under which environment, its result, and who decided it",
  usage: 'mp read full-runs <mission>',
  flags: {},
  async run(c, args) {
    const p = P(c);
    const m = positional(args, 0, 'mission');
    const markers = p.ctx.memory.read((db) => fullRunMarkers(db, p.ctx.memory.data, m));
    const text = markers.length === 0 ? `Mission ${m} has no full run recorded.` : [`Full runs of mission ${m} (newest first): ${markers.length}`, ...markers.flatMap((x) => fullRunLines(x))].join('\n');
    return ok(text, { mission: m, markers });
  },
};



const secretaryRead: Command = {group: 'read', name: ['secretary'], summary: 'the resident generation, handle, claim and last command times', usage: 'mp read secretary', flags: {}, async run(c) {const p = P(c); const all = generations(p.ctx.memory); const live = liveSecretary(p.ctx.memory); const current = live ?? all.filter((g) => g.state === 'pending').at(-1) ?? null; return ok(current === null ? 'No pending or live Secretary; the 4.2 PM loop is available.' : `${current.generation} ${current.state}: ${current.name}\nHandle: ${current.handle ?? '(not recorded; stop by name)'}; claimed: ${current.claimedAt ?? 'not yet'}; last command: ${current.lastCommandAt ?? 'none'}`, {live, current, generations: all});}};
const wordsRead: Command = {
  group: 'read', name: ['words'], summary: 'layer 2 words by tag, mission, force, text or untyped entries', usage: 'mp read words [--tag <type>] [--mission <mission>] [--in-force|--all] [--grep <text>] [--untyped]', flags: {tag: 'string', mission: 'string', 'in-force': 'boolean', all: 'boolean', grep: 'string', untyped: 'boolean'},
  async run(c, a) {const p = P(c); const tag = flagStr(a, 'tag'), mission = flagStr(a, 'mission'), grep = flagStr(a, 'grep')?.toLocaleLowerCase(); if (tag !== null && !['principle','decision','requirement','instruction'].includes(tag)) throw usage('unknown words tag'); if (flagBool(a, 'all') && flagBool(a, 'in-force')) throw usage('choose --all or --in-force'); const entries = taggedWords(p.ctx.memory, p.ctx.memory.data); const words = entries.map((w) => ({...w, tags: w.tags.filter((t) => (tag === null || t.type === tag) && (mission === null || t.mission === mission) && (!flagBool(a, 'in-force') || t.inForce))})).filter((w) => (flagBool(a, 'untyped') ? w.tags.length === 0 && entries.find((x) => x.words === w.words)!.tags.length === 0 : w.tags.length > 0 || (tag === null && mission === null && !flagBool(a, 'in-force'))) && (grep === undefined || w.text.toLocaleLowerCase().includes(grep))); return ok(words.length ? words.flatMap((w) => w.tags.length ? w.tags.map((t) => `[${t.id}] ${t.type}${t.mission ? ` @${t.mission}` : ''} (${t.inForce ? 'in force' : 'out of force'}): ${t.quote ?? w.text}`) : [`[${w.words}] untyped: ${w.text}`]).join('\n') : 'No matching words.', {words});},
};

// 4.4 (G8): the notes the PM sent, so a new session need not keep its own list
const notesRead: Command = {
  group: 'read', name: ['notes'], summary: 'the PM\'s notes to the Secretary, each with its state: current, acknowledged, or replaced (--all lists the replaced ones too)', usage: 'mp read notes [--all]', flags: {all: 'boolean'},
  async run(c, a) {
    const all = pmNotes(P(c).ctx.memory);
    const notes = flagBool(a, 'all') ? all : all.filter((n) => n.state !== 'replaced');
    const hidden = all.length - notes.length;
    const lines = notes.map((n) => `[${n.id}] ${n.state === 'replaced' ? `replaced by ${n.replacedBy}` : n.state}${n.replaces !== null ? ` (replaces ${n.replaces})` : ''}${n.words !== null ? ` (${n.words})` : ''}: ${n.text}`);
    if (hidden > 0) lines.push(`${hidden} replaced note(s): mp read notes --all`);
    return ok(lines.length > 0 ? lines.join('\n') : 'No notes.', {notes});
  },
};

// 4.4 (G3): who wrote each constraint and what it reaches, so a PM that writes for tasks again can be seen
const constraintsReadCmd: Command = {
  group: 'read', name: ['constraints'], summary: 'the constraints in force for a mission, each with its author (PM or Secretary) and its address or scope; --reach adds the task cards each reaches, its size and the Reviewers\' answers', usage: 'mp read constraints <mission> [--reach]', flags: {reach: 'boolean'},
  async run(c, a) {const p = P(c); const m = positional(a, 0, 'mission'); const reach = flagBool(a, 'reach'); const r = p.ctx.memory.read((db) => constraintsRead(db, p.ctx.memory.data, m, reach)); return ok(constraintsText(r, reach), r);},
};
// 4.4 (the plan's F13): each repair, what it did and whether it is done
const repairsReadCmd: Command = {
  group: 'read', name: ['repairs'], summary: 'a mission\'s repairs: kind, words, subject and the Architect\'s note; whether it was filed again (--again); the tasks each added, changed and reopened with their state (a reopen waiting for an attempt, carried out, or not carried out and why); its dispatches; and whether it is done', usage: 'mp read repairs <mission>', flags: {},
  async run(c, a) {const p = P(c); const m = positional(a, 0, 'mission'); const r = p.ctx.memory.read((db) => repairsRead(db, p.ctx.memory.data, m)); return ok(repairsText(r), r);},
};

// 4.4 (F4; G5): what is left open and what became of it, from the record: the questions put off, and what
// was left at the cap (an acceptance with risk's items, a Reviewer's deferrals, the risk sentences of 4.3).
// v1-4: three things are counted apart (items recorded by 4.4 that are open; those answered or closed; the risk
// sentences of acceptances made before 4.4 nobody acted on, whose fate is not recorded), and only the first is
// called open. The 4.4 items are listed in full; the sentences before 4.4 as a count per task (`--all` lists them).
const openItemsRead: Command = {
  group: 'read', name: ['open-items'], summary: 'a mission\'s open items: a Constructor\'s questions put off or raised as later (who answers each, its answer), and what was left at the cap (each risk an acceptance with risk took on, each deferred issue; kind verify: a standard that could not be verified, with what is needed, or one a person checks), with its age, how often it was carried, what took it and what became of it; the risk sentences of acceptances made before 4.4 that nobody acted on are counted apart (what became of them is not recorded) and listed per task', usage: 'mp read open-items <mission> [--open | --all]   (--open: only what 4.4 records as open; --all: the risk sentences of acceptances made before 4.4 in full too)', flags: { open: 'boolean', all: 'boolean' },
  async run(c, a) {
    const m = positional(a, 0, 'mission');
    const p = P(c);
    const only = flagBool(a, 'open');
    const full = flagBool(a, 'all');
    if (only && full) throw usage('choose --open (only what 4.4 records as open) or --all (the risk sentences of acceptances made before 4.4 in full too)');
    const all = listAllItems(p.ctx, m);
    const questions = only ? all.questions.filter((q) => q.answer === null) : all.questions;
    const recorded = all.items.filter((i) => i.state !== 'not recorded');
    const before = all.items.filter((i) => i.state === 'not recorded');
    const risks = only ? recorded.filter((i) => i.state === 'open') : full ? all.items : recorded;
    const now = p.ctx.now();
    // 4.4 (G1): a question answered by the Architect's answer carried out on its escalation
    const who = (x: 'secretary' | 'pm' | 'user' | 'architect'): string => (x === 'pm' ? 'the PM' : x === 'user' ? 'the user' : x === 'architect' ? 'the Architect' : 'the Secretary');
    const old = (at: number | null | undefined): string => (at == null ? '' : `, ${age(now - at)} old`);
    const lines = [
      ...questions.map((i) => ({ revision: i.revision, text: `[${i.id}] ${i.kind}, task ${i.task} (attempt ${i.attempt}, ${i.why === 'later' ? 'raised as later' : 'put off by its answer'}): ${i.answer === null ? `open; ${who(i.decider)} answers it` : `answered by ${who(i.answer.by)}${i.answer.words !== undefined ? ` on ${i.answer.words}` : ''}`}\n  ${i.text}${i.answer !== null ? `\n  Answer: ${i.answer.answer}` : ''}${i.superseded !== undefined ? `\n  (the answer carried out on its escalation took precedence over ${who(i.superseded.by)}'s earlier answer: ${i.superseded.answer})` : ''}` })),
      ...risks.map((i) => ({ revision: i.revision, text: riskItemLine(i, old(i.at)) })),
    ].sort((x, y) => x.revision - y.revision).map((x) => x.text);
    // the header counts the mission's items whatever the flags: open (4.4), answered or closed (4.4), and apart the sentences before 4.4
    const open = all.questions.filter((i) => i.answer === null).length + recorded.filter((i) => i.state === 'open').length;
    const done = all.questions.length + recorded.length - open;
    if (all.questions.length + all.items.length === 0) return ok(`Mission ${m} has no open items.`, { mission: m, items: [] });
    const head = `Open items of mission ${m}: ${open} open, ${done} answered or closed${before.length > 0 ? `; ${beforeText(before.length)}` : ''}`;
    const byTask = !only && !full ? notRecordedByTask(all.items) : [];
    const grouped = byTask.length === 0 ? [] : [`Risk sentences of acceptances made before 4.4, per task (what became of them is not recorded; mp read open-items ${m} --all lists them):`, ...byTask.map((t) => `  task ${t.task}: ${t.count} risk sentence${t.count === 1 ? '' : 's'} accepted before 4.4`)];
    return ok([head, ...lines, ...grouped].join('\n'), { mission: m, items: [...questions, ...risks].sort((x, y) => x.revision - y.revision), ...(byTask.length > 0 ? { notRecorded: byTask } : {}) });
  },
};

/** 4.4 (G5): one item left at the cap, from its record: where it was left, its state, and what took it. */
function riskItemLine(i: RiskItemView, old: string): string {
  // 4.4 (F10): a standard a person checks is written when its task is accepted (one that could not be verified says in its text what is needed)
  // v1-4: a sentence of an acceptance made before 4.4 that someone acted on is recorded since, and says so
  const left = i.why === 'deferred' ? `deferred by its Reviewer ${i.review ?? ''}`.trimEnd() : i.why === 'person' ? 'a standard a person checks, written when the task was accepted' : `accepted with risk on ${i.escalation}${i.before44 === true && i.state !== 'not recorded' ? ' before 4.4, recorded when it was acted on' : ''}`;
  // p10-5: a fix that did not reach the fix tracker is said so (the issue of a 4.3 finding could not be recovered)
  const tracker = i.trackerTold === false ? ' (the fix tracker was not told: the issue this item is about could not be found)' : '';
  const state = i.closed !== null ? `closed, ${closureText(i.closed)}${tracker}` : i.state === 'not recorded' ? 'not recorded as an item (an acceptance with risk made before 4.4): what became of it is not recorded' : 'open';
  const took = i.takenBy.length > 0 ? `; taken by ${i.takenBy.map((t) => `task ${t.task} (${t.by})`).join(', ')}` : i.closed === null ? '; taken by no task' : '';
  const named = i.namedBy.length > 0 ? `; named by repair ${i.namedBy.join(', ')}` : '';
  const answer = i.answer !== null && i.closed?.how !== 'fixed' ? `\n  At the acceptance of task ${i.answer.task} (attempt ${i.answer.attempt}) its Reviewer answered it ${i.answer.response}: ${i.answer.reason}` : '';
  return `[${i.id}] ${i.kind}, task ${i.task} (attempt ${i.attempt}, ${left}): ${state}${old}${i.carried > 0 ? `; carried ${i.carried}` : ''}${took}${named}\n  ${i.text}${answer}`;
}

// 4.4 (the plan's F15, G5): the user's question "how far is each thing I asked for", from one read
const itemsRead: Command = {
  group: 'read', name: ['items'], summary: 'one line per requirement item and one per repair, with its state (not planned, planned, in work, accepted after a passing review, accepted with risk (n open), abandoned, delivered, landed), its proof label and the user\'s statements that it was checked in the field (the user\'s words, never proof)', usage: 'mp read items <mission>', flags: {},
  async run(c, a) {
    const m = positional(a, 0, 'mission');
    const xs = readItems(P(c).ctx, m);
    const req = xs.filter((x) => x.kind === 'requirement');
    const rep = xs.filter((x) => x.kind === 'repair');
    const text = xs.length === 0 ? `Mission ${m} has no requirement item and no repair.` : [
      `Requirement items of mission ${m}: ${req.length}`, ...req.flatMap(itemStateLines),
      ...(rep.length > 0 ? [`Repairs: ${rep.length}`, ...rep.flatMap(itemStateLines)] : []),
    ].join('\n');
    return ok(text, { mission: m, items: xs });
  },
};

// 4.4 (F10, P12): the health of the review seat, read in one snapshot
const reviewsRead: Command = {
  group: 'read', name: ['reviews'], summary: 'the health of a mission\'s review seat: the share of pass, rework and needs-decision of its Reviewer hand-backs, per filler of the Reviewer seat and per week (UTC), and each change of filler', usage: 'mp read reviews <mission>', flags: {},
  async run(c, a) {
    const p = P(c);
    const m = positional(a, 0, 'mission');
    const h = p.ctx.memory.read((db) => reviewHealth(m, reviewRows(db, p.ctx.memory.data, m)));
    if (h.all.reviews === 0) return ok(`Mission ${m} has no accepted Reviewer hand-back.`, h);
    const lines = [
      `Reviews of mission ${m}: ${sharesLine(h.all)}`,
      'By filler of the Reviewer seat:',
      ...h.byFiller.map((f) => `  ${f.filler}: ${sharesLine(f)}`),
      'By week (UTC):',
      ...h.byWeek.map((w) => `  ${w.week}: ${sharesLine(w)}`),
      ...(h.changes.length === 0 ? ['The filler of the Reviewer seat did not change.'] : ['Changes of filler:', ...h.changes.map((x) => `  review ${x.at} (${x.dispatch}): ${x.from} to ${x.to}; the ${x.before.reviews} before: pass ${x.before.reviews === 0 ? 0 : Math.round((100 * x.before.pass) / x.before.reviews)}%; the ${x.since.reviews} since (latest): pass ${x.since.reviews === 0 ? 0 : Math.round((100 * x.since.pass) / x.since.reviews)}%${x.fell ? ' (under half of the share before)' : ''}`)]),
    ];
    return ok(lines.join('\n'), h);
  },
};

export const READ_COMMANDS: readonly Command[] = [secretaryRead, wordsRead, notesRead, constraintsReadCmd, repairsReadCmd, openItemsRead, itemsRead, reviewsRead, status, blocked, showCmd, leaf, why, from, chainCmd, treeCmd, fullRuns];
