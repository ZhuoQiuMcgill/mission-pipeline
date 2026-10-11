// `mp read …`: the layered reads and the tree reads (design 4.1 §8). Reads change nothing except
// "since the maintainer last asked" (`mp read status` moves it, unless --no-mark).

import { flagBool, positional } from '../args.ts';
import { ok, type Command, type RunContext } from '../command.ts';
import { CliError, EXIT, refused, usage } from '../errors.ts';
import type { Project } from '../project.ts';
import { markAsked, readStatus, SHOW_KINDS, showItem, statusText } from '../status.ts';
import { entryLines, resolveSubtasks } from '../layers.ts';
import { buildGraph, chain, resolveNodes, tree, walk } from '../tree.ts';

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
  usage: `mp read show <kind> <id>   (kinds: ${SHOW_KINDS.join(', ')})`,
  flags: {},
  async run(c, args) {
    const kind = positional(args, 0, 'kind');
    if (!SHOW_KINDS.includes(kind)) throw usage(`the kind is one of ${SHOW_KINDS.join(', ')}`);
    const id = positional(args, 1, 'id');
    const r = await showItem(P(c), kind, id);
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
  summary: 'walk forward: everything that rests on a node (what a withdrawn requirement or a refuted version affects)',
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

export const READ_COMMANDS: readonly Command[] = [status, blocked, showCmd, leaf, why, from, chainCmd, treeCmd];
