// Seeing the tree connected (design 4.1 §3.2, §8.4; U-13, U-14: "the database is the skeleton, the
// .md files are the leaves; the database exists so the whole tree can be seen connected").
//
// The skeleton's records are read into one graph of nodes and "rests on" links, every link a
// recorded value (never parsed out of a leaf):
//
//   words W-n            the words table (`mp pm say`)
//   requirement <ver>    a requirements/item flow event: its words entry and verbatim quote (or the
//                        authorization it rests on)
//   plan / object <id>   object versions: a PM plan (its pm-batch event: the words it was asked
//                        for in), a detailed plan (the plan/arch event: the Architect dispatch that
//                        handed it back), a product (the task line's product event: the Constructor
//                        dispatch and the candidate commit), exploration versions; plus the
//                        object's review contracts (the requirement lines and objects it relies on)
//   task <id>            the dispatch table: the task's spec names what it works on (the objects it
//                        binds, the PM plan an Architect decomposes, the detailed plan a Constructor
//                        task was planned in, the escalation a Secretary decides, the exploration)
//   dispatch D-n         the task it claimed, its filler, its hand-back (outcome, candidate,
//                        records), its card and report leaves, the runs it had `mp` rerun
//   judgment <id>        its target, the runs it cites, its bases and what it relies on; the
//                        dispatch whose accepted hand-back carried it
//   run <id>             evidence records: the product or commit it ran on, the delivery whose
//                        closing check it was
//   commit <sha>         a candidate (rests on its product version) or a delivery commit
//   delivery, landing    the deliveries table and its document (selected outputs, the words that
//                        asked for it), landing intents (the words that consented)
//   escalation, decision the Secretary line; the user's answers name their words entry
//   exploration, stop    exploration definitions (state: the latest of stopped / settled / reopened
//                        by a rerun, so a settle stands only until a rerun reopens it); stops with
//                        their words entry
//
// Reads: why (walk the "rests on" links back to the maintainer's words), from (walk them
// forward), chain (one dispatch), tree (a mission as one indented tree). Each node shows its
// state, the program's checks, who handed it over and its leaf (hash-checked on display).

import { canonicalJson } from '../common/hash.ts';
import type { MissionId } from '../common/ids.ts';
import type { ListRef } from '../common/records.ts';
import { judgmentStates, labelStatus } from '../evaluator/index.ts';
import type { Db } from '../memory/index.ts';
import { PLAN_LINE, REPAIRS_LINE, REQUIREMENTS_LINE, SECRETARY_LINE } from '../flow/plandoc.ts';
import { builtOnOlder, lineAcceptance } from '../flow/execution.ts';
import { purposeOf, type ProcessContext } from '../process/index.ts';
import { age, clip, filler as fillerText, short } from './render.ts';

export type NodeKind = 'mission' | 'words' | 'requirement' | 'constraint' | 'plan' | 'object' | 'task' | 'dispatch' | 'judgment' | 'run' | 'commit' | 'delivery' | 'landing' | 'escalation' | 'decision' | 'exploration' | 'stop' | 'repair';

export interface GNode {
  readonly key: string;
  readonly kind: NodeKind;
  readonly id: string;
  readonly mission: string | null;
  /** One line of what it is. */
  title: string;
  state: string | null;
  /** The program's checks on this step (§3.2 item 4), or null when it has none. */
  checks: string | null;
  /** Who handed it over (a seat and its dispatch, the PM and its command, the user). */
  by: string | null;
  /** Leaf ids (§3.2 item 12), shown with their hash check. */
  readonly leaves: string[];
  readonly rev: number;
}

export interface GEdge {
  /** The node that rests on `to`. */
  readonly from: string;
  readonly to: string;
  readonly rel: string;
}

export interface Graph {
  readonly nodes: Map<string, GNode>;
  /** What each node rests on, in the order the primary parent is chosen. */
  readonly out: Map<string, GEdge[]>;
  /** What rests on each node. */
  readonly inn: Map<string, GEdge[]>;
  readonly recomputing: boolean;
}

const KIND_LABEL: Readonly<Record<NodeKind, string>> = {
  mission: 'mission',
  words: 'words',
  requirement: 'requirement',
  constraint: 'constraint',
  plan: 'plan',
  object: 'object',
  task: 'task',
  dispatch: 'dispatch',
  judgment: 'judgment',
  run: 'run',
  commit: 'commit',
  delivery: 'delivery',
  landing: 'landing',
  escalation: 'escalation',
  decision: 'decision',
  exploration: 'exploration',
  stop: 'stop',
  repair: 'repair',
};

type Json = Record<string, any>;

interface FlowRow {
  readonly mission: string;
  readonly line: string;
  readonly event: string;
  readonly key: string;
  readonly body: Json;
  readonly rev: number;
}

const ITEM_LINE = /^item\./;

/** Build the graph of one mission (with the words it rests on), or of the whole memory. */
export function buildGraph(ctx: ProcessContext, o: { readonly mission?: string | null } = {}): Graph {
  const memory = ctx.memory;
  const data = memory.data;
  const parse = (h: unknown): Json | null => {
    if (typeof h !== 'string') return null;
    try {
      return JSON.parse(data.text(h)) as Json;
    } catch {
      return null;
    }
  };
  const list = (ref: unknown): string[] => {
    if (ref === null || typeof ref !== 'object') return [];
    try {
      return data.getList(ref as ListRef);
    } catch {
      return [];
    }
  };
  const nodes = new Map<string, GNode>();
  const out = new Map<string, GEdge[]>();
  const inn = new Map<string, GEdge[]>();
  const only = o.mission ?? null;

  return memory.read((db: Db) => {
    const node = (kind: NodeKind, id: string, mission: string | null, rev: number, title = ''): GNode => {
      const key = `${kind}:${id}`;
      let n = nodes.get(key);
      if (n === undefined) {
        n = { key, kind, id, mission, title, state: null, checks: null, by: null, leaves: [], rev };
        nodes.set(key, n);
      }
      return n;
    };
    const edge = (from: string, to: string, rel: string): void => {
      if (from === to) return;
      const xs = out.get(from) ?? [];
      if (xs.some((e) => e.to === to)) return;
      xs.push({ from, to, rel });
      out.set(from, xs);
      const ys = inn.get(to) ?? [];
      ys.push({ from, to, rel });
      inn.set(to, ys);
    };
    const inMission = (m: string | null): boolean => only === null || m === only;

    // ---- the leaves each write recorded (a flow event's leaf is the one its write recorded)
    const leavesByOp = new Map<string, string[]>();
    for (const r of db.stmt('SELECT leaf, op FROM leaves WHERE op IS NOT NULL ORDER BY rev').all() as Array<{ leaf: string; op: string }>) {
      const xs = leavesByOp.get(r.op) ?? [];
      xs.push(r.leaf);
      leavesByOp.set(r.op, xs);
    }
    const opOfRev = new Map<number, string>();
    for (const r of db.stmt("SELECT rev, op FROM log WHERE op IS NOT NULL AND kind IN ('flow.event', 'evidence', 'delivery.recorded', 'object.version')").all() as Array<{ rev: number; op: string }>) opOfRev.set(Number(r.rev), r.op);
    const leafOf = (rev: number, prefix: RegExp): string[] => {
      const op = opOfRev.get(rev);
      return op === undefined ? [] : (leavesByOp.get(op) ?? []).filter((l) => prefix.test(l));
    };

    // ---- labels, judgment currency
    const labels = new Map((db.stmt('SELECT target, label FROM lbl_labels').all() as Array<{ target: string; label: string }>).map((r) => [r.target, r.label]));
    const recomputing = labelStatus(db).recomputing;

    // ---- who issued each PM command (§3.2 item 13): the PM actions' results name what they made
    const pmFiller = new Map<string, string>();
    for (const r of db.stmt('SELECT op, harness, model FROM pm_commands').all() as Array<{ op: string; harness: string | null; model: string | null }>) pmFiller.set(r.op, r.harness === null ? 'unknown filler' : fillerText({ harness: r.harness, model: r.model }));
    const pmBy = new Map<string, string>();
    for (const r of db.stmt("SELECT action, command, result FROM pm_actions WHERE state = 'done' AND result IS NOT NULL ORDER BY rev").all() as Array<{ action: string; command: string; result: string }>) {
      const res = parse(r.result);
      const j = (res?.['json'] ?? null) as Json | null;
      if (j === null) continue;
      const who = `the PM via \`mp pm ${r.command}\` (${pmFiller.get(`pm:${r.action}`) ?? 'unknown filler'})`;
      for (const k of pmResultKeys(r.command, j)) if (!pmBy.has(k)) pmBy.set(k, who);
    }

    // ---- the maintainer's words
    for (const r of db.stmt('SELECT words, at, text, leaf, rev FROM words ORDER BY rev').all() as Array<{ words: string; at: number; text: string; leaf: string | null; rev: number }>) {
      let text = '';
      try {
        text = data.text(r.text);
      } catch {
        text = '(the text is not in the memory)';
      }
      const n = node('words', r.words, null, Number(r.rev), `"${clip(text, 120)}"`);
      n.state = `recorded ${new Date(Number(r.at)).toISOString().slice(0, 16).replace('T', ' ')}`;
      n.by = pmBy.get(n.key)?.replace(/^the PM via/, 'the user; recorded by the PM via') ?? 'the user';
      if (r.leaf !== null) n.leaves.push(r.leaf);
    }

    // ---- flow events, in commit order
    const flows: FlowRow[] = [];
    const q = only === null ? db.stmt('SELECT mission, line, event, key, body, revision FROM flow_events ORDER BY revision').all() : db.stmt('SELECT mission, line, event, key, body, revision FROM flow_events WHERE mission = ? ORDER BY revision').all(only);
    for (const r of q as Array<{ mission: string; line: string; event: string; key: string; body: string; revision: number }>) {
      flows.push({ mission: r.mission, line: r.line, event: r.event, key: r.key, body: parse(r.body) ?? {}, rev: Number(r.revision) });
    }

    const decisionHistory = new Map<string, string[]>();
    const decisionRev = new Map<string, number>();
    const byKey = new Map<string, FlowRow>();
    const flowKey = (m: string, line: string, event: string, key: string): string => JSON.stringify([m, line, event, key]);
    const escalationsOfTask = new Map<string, FlowRow[]>();
    const effectivePlans: FlowRow[] = [];
    for (const f of flows) {
      byKey.set(flowKey(f.mission, f.line, f.event, f.key), f);
      if (f.line === SECRETARY_LINE && f.event === 'escalation' && typeof f.body['task'] === 'string') escalationsOfTask.set(f.body['task'], [...(escalationsOfTask.get(f.body['task']) ?? []), f]);
      if (f.line === PLAN_LINE && f.event === 'pm-plan-effective') effectivePlans.push(f);
    }

    // requirement item versions, and the version of a line in force at a revision
    const itemVersions = new Map<string, Array<{ version: string; rev: number }>>();
    const withdrawn = new Map<string, number>();
    const versionAt = (line: string, rev: number): string | null => {
      const xs = itemVersions.get(line) ?? [];
      let v: string | null = null;
      for (const x of xs) if (x.rev <= rev) v = x.version;
      return v ?? xs[xs.length - 1]?.version ?? null;
    };
    for (const f of flows) {
      if (f.line !== REQUIREMENTS_LINE) continue;
      const b = f.body;
      if (f.event === 'item' && typeof b['version'] === 'string') {
        const n = node('requirement', b['version'], f.mission, f.rev, `${String(b['type'] ?? '')}: ${clip(String(b['text'] ?? ''), 120)}`);
        n.by = pmBy.get(n.key) ?? 'the PM via `mp pm requirement add`';
        n.leaves.push(...leafOf(f.rev, /requirements\.md#/));
        const line = String(b['line'] ?? '');
        const xs = itemVersions.get(line) ?? [];
        xs.push({ version: b['version'], rev: f.rev });
        itemVersions.set(line, xs);
        const src = (b['source'] ?? {}) as Json;
        if (src['kind'] === 'words' && typeof src['words'] === 'string') {
          node('words', src['words'], null, 0);
          edge(n.key, `words:${src['words']}`, `quotes "${clip(String(src['quote'] ?? ''), 60)}"`);
        } else if (src['kind'] === 'authorization' && typeof src['line'] === 'string') {
          const v = versionAt(src['line'], f.rev);
          if (v !== null) edge(n.key, `requirement:${v}`, 'rests on authorization');
        }
      } else if (f.event === 'withdrawn' && typeof b['line'] === 'string') withdrawn.set(b['line'], f.rev);
      else if (f.event === 'constraint') {
        const id = String(b['version'] ?? f.key);
        const n = node('constraint', id, f.mission, f.rev, `${String(b['kind'] ?? '')}: ${clip(String(b['text'] ?? ''), 120)}`);
        n.by = pmBy.get(n.key) ?? 'the PM via `mp pm constraint add`';
        n.state = 'recorded';
        n.leaves.push(...leafOf(f.rev, /requirements\.md#|constraints\.md#/));
      }
    }
    // contested items (Calibrator ① asked the user; released when a later plan passes): the last event per line wins
    const contested = new Map<string, boolean>();
    for (const f of flows) if (f.line === REQUIREMENTS_LINE && f.event === 'contested' && typeof f.body['line'] === 'string') contested.set(`${f.mission}\n${f.body['line']}`, f.body['contested'] === true);
    for (const [line, xs] of itemVersions) {
      xs.forEach((x, i) => {
        const n = nodes.get(`requirement:${x.version}`);
        if (n === undefined) return;
        n.state = i < xs.length - 1 ? 'superseded' : withdrawn.has(line) ? 'withdrawn' : contested.get(`${n.mission}\n${line}`) === true ? 'contested' : 'in force';
      });
    }

    // ---- object versions (plans, products, exploration versions)
    const objects = new Map<string, Json & { rev: number }>();
    for (const r of db.stmt("SELECT rev, record FROM log WHERE kind = 'object.version' ORDER BY rev").all() as Array<{ rev: number; record: string }>) {
      const rec = JSON.parse(r.record) as Json;
      if (!inMission(rec['mission'] ?? null)) continue;
      objects.set(String(rec['object']), { ...rec, rev: Number(r.rev) });
    }
    const objNode = (id: string, rev = 0): GNode => {
      const rec = objects.get(id);
      const kind: NodeKind = rec?.['objectKind'] === 'plan' ? 'plan' : 'object';
      const n = node(kind, id, rec?.['mission'] ?? null, rec?.rev ?? rev);
      return n;
    };
    const objKey = (id: string): string => `${objects.get(id)?.['objectKind'] === 'plan' ? 'plan' : 'object'}:${id}`;
    for (const [id, rec] of objects) {
      const n = objNode(id);
      const okind = String(rec['objectKind']);
      n.title ||= `${okind}${rec['module'] ? ` of module ${rec['module']}` : ''}${Array.isArray(rec['scope']?.['paths']) && okind !== 'plan' ? `: ${clip((rec['scope']['paths'] as string[]).join(', '), 100)}` : ''}`;
      const l = labels.get(id);
      n.state = l === undefined ? 'no label yet' : `${l}${recomputing ? ' (recomputing)' : ''}`;
      if (typeof rec['predecessor'] === 'string') edge(n.key, objKey(rec['predecessor']), 'revises');
      for (const c of (rec['reviews'] ?? []) as Json[]) {
        for (const r of (c['reliesOn'] ?? []) as string[]) edge(n.key, objKey(r), 'relies on');
        for (const line of (c['basisLines'] ?? []) as string[]) {
          if (!ITEM_LINE.test(line)) continue;
          const v = versionAt(line, rec.rev);
          if (v !== null) edge(n.key, `requirement:${v}`, 'based on');
        }
      }
      for (const p of list(rec['prerequisites'])) edge(n.key, objKey(p), 'requires');
      const commit = rec['source']?.['commit'];
      if (typeof commit === 'string') {
        const c = node('commit', commit, rec['mission'] ?? null, rec.rev, `the candidate of ${id}`);
        edge(c.key, n.key, 'is the candidate of');
      }
    }

    // ---- tasks and dispatches (the dispatch table)
    const tasks = new Map<string, { row: Json; spec: Json | null }>();
    const tq = only === null ? db.stmt('SELECT * FROM tasks ORDER BY queued_rev').all() : db.stmt('SELECT * FROM tasks WHERE mission = ? ORDER BY queued_rev').all(only);
    for (const r of tq as Json[]) tasks.set(String(r['task']), { row: r, spec: parse(r['card']) });
    const dispatches = new Map<string, { row: Json; doc: Json | null }>();
    const dq = only === null ? db.stmt('SELECT * FROM dispatches ORDER BY claimed_rev').all() : db.stmt('SELECT * FROM dispatches WHERE mission = ? ORDER BY claimed_rev').all(only);
    for (const r of dq as Json[]) dispatches.set(String(r['dispatch']), { row: r, doc: parse(r['result']) });
    const dispatchesOfTask = new Map<string, string[]>();
    for (const [d, x] of dispatches) {
      const xs = dispatchesOfTask.get(String(x.row['task'])) ?? [];
      xs.push(d);
      dispatchesOfTask.set(String(x.row['task']), xs);
    }
    /** The dispatch of a task whose hand-back was accepted (else its latest). */
    const handingDispatch = (task: string): string | null => {
      const ds = dispatchesOfTask.get(task) ?? [];
      return ds.find((d) => dispatches.get(d)?.row['handback'] === 'accepted') ?? ds[ds.length - 1] ?? null;
    };
    const seatBy = (d: string | null): string | null => {
      if (d === null) return null;
      const x = dispatches.get(d);
      if (x === undefined) return `dispatch ${d}`;
      const f = x.row['filler_harness'] === null ? null : { harness: String(x.row['filler_harness']), model: (x.row['filler_model'] as string | null) ?? null };
      return `${String(x.row['seat'])}, dispatch ${d} (${fillerText(f)})`;
    };
    // what each accepted hand-back carried: judgments and object versions by id (a hand-back after a
    // release or a stop is recorded, not accepted: what it carried was never committed as its own)
    const handedIn = new Map<string, string>();
    for (const [d, x] of dispatches) {
      if (x.row['handback'] !== 'accepted') continue;
      for (const rec of ((x.doc?.['records'] ?? []) as Json[])) {
        const id = rec['kind'] === 'judgment' ? rec['judgment'] : rec['kind'] === 'object.version' ? rec['object'] : rec['kind'] === 'issue' ? rec['issue'] : null;
        if (typeof id === 'string' && !handedIn.has(id)) handedIn.set(id, d);
      }
    }

    for (const [task, { row, spec }] of tasks) {
      const card = (spec?.['card'] ?? { seat: '?' }) as Json & { seat: string };
      const n = node('task', task, String(row['mission']), Number(row['queued_rev']));
      let purpose = '';
      try {
        purpose = purposeOf(card);
      } catch {
        purpose = String(card.seat);
      }
      n.title = `${card.seat}: ${clip(purpose, 120)}`;
      n.state = String(row['state']);
      n.by = 'queued by mp';
    }
    for (const [d, { row, doc }] of dispatches) {
      const n = node('dispatch', d, String(row['mission']), Number(row['claimed_rev']));
      const f = row['filler_harness'] === null ? null : { harness: String(row['filler_harness']), model: (row['filler_model'] as string | null) ?? null };
      n.title = `${String(row['seat'])} on task ${String(row['task'])}, filled by ${fillerText(f)}`;
      n.state = row['state'] === 'in-flight' ? `in flight for ${age(ctx.now() - Number(row['created_at']))}` : row['state'] === 'released' ? `released (${String(row['released'])})` : `handed back (${String(row['handback'])})`;
      n.checks =
        row['handback'] === 'accepted'
          ? `hand-back passed the checks${doc?.['kind'] === 'needs-evidence' ? ' (asked for evidence)' : ''}${doc?.['fullReview'] ? `; ${String(doc['fullReview'])}` : ''}`
          : row['handback'] === 'after-release'
            ? 'recorded after its release, not accepted'
            : row['handback'] === 'after-stop'
              ? 'recorded after a stop, not accepted'
              : null;
      n.by = pmBy.get(n.key) ?? 'the PM via `mp pm dispatch`';
      if (row['card_leaf']) n.leaves.push(String(row['card_leaf']));
      if (row['report_leaf']) n.leaves.push(String(row['report_leaf']));
      edge(n.key, `task:${String(row['task'])}`, 'claimed');
      const cand = doc?.['candidate']?.['commit'];
      if (typeof cand === 'string') {
        const c = node('commit', cand, String(row['mission']), Number(row['claimed_rev']), `the candidate collected from dispatch ${d}`);
        edge(c.key, n.key, 'collected from');
      }
    }

    // ---- the flows' own links
    for (const f of flows) {
      const b = f.body;
      if (f.line === PLAN_LINE) {
        if (f.event === 'pm-batch' && typeof b['plan'] === 'string') {
          const n = objNode(b['plan'], f.rev);
          n.title = `PM plan, batch ${String(b['batch'])} (round ${String(b['round'] ?? 1)})`;
          n.by = pmBy.get(n.key) ?? 'the PM via `mp pm plan submit`';
          n.leaves.push(...leafOf(f.rev, /\/plans\//));
          // the plan rests first on the requirement items its review is bound to, then on the words it was asked for in
          for (const w of (b['userWords'] ?? []) as string[]) {
            node('words', w, null, 0);
            edge(n.key, `words:${w}`, 'asked for in');
          }
        } else if (f.event === 'arch' && typeof b['object'] === 'string') {
          const n = objNode(b['object'], f.rev);
          n.title = `detailed plan (Architect, attempt ${String(b['k'] ?? 1)})`;
          const d = handingDispatch(String(b['task']));
          n.by = seatBy(d);
          if (d !== null) edge(n.key, `dispatch:${d}`, 'handed back by');
          n.leaves.push(...leafOf(f.rev, /\/plans\//));
        } else if (f.event === 'mechanical-check') {
          const n = nodes.get(objKey(f.key));
          if (n !== undefined) addCheck(n, b['ok'] === true ? 'mechanical checks passed' : `mechanical checks failed (${((b['failures'] ?? []) as unknown[]).length})`);
        } else if (f.event === 'cal1' || f.event === 'cal2' || f.event === 'feasibility') {
          const target = f.event === 'cal1' ? targetOfTask(tasks, String(b['task'])) : String(b['dplan'] ?? '');
          const n = target === null ? undefined : nodes.get(objKey(target));
          const what = f.event === 'cal1' ? 'Calibrator ①' : f.event === 'cal2' ? 'Calibrator ②' : 'feasibility review';
          if (n !== undefined) addCheck(n, `${what}: ${String(b['outcome'] ?? b['verdict'] ?? '?')} (${handingDispatch(String(b['task'])) ?? '?'})`);
        } else if (f.event === 'effective' && typeof b['dplan'] === 'string' && f.key.includes('#a')) {
          // 4.1.2 (D-10): a repair's amendment of the plan in effect (the same plan version)
          const n = nodes.get(objKey(b['dplan']));
          const last = ((b['amendments'] ?? []) as Json[]).at(-1);
          if (n !== undefined && last !== undefined) addCheck(n, `amended by repair ${String(last['repair'])}: adds ${((last['tasks'] ?? []) as Json[]).map((t) => String(t['id'])).join(', ')}`);
        } else if (f.event === 'effective' && typeof b['dplan'] === 'string') {
          const n = nodes.get(objKey(b['dplan']));
          if (n !== undefined) n.state = `${n.state ?? ''}; in effect (tasks ${((b['tasks'] ?? []) as string[]).join(', ')})`.replace(/^; /, '');
        }
      } else if (f.line.startsWith('task:')) {
        if (f.event === 'dispatched' && typeof b['dplan'] === 'string') edge(`task:${f.key}`, objKey(b['dplan']), 'planned in');
        else if (f.event === 'product' && typeof b['object'] === 'string') {
          const n = objNode(b['object'], f.rev);
          if (typeof b['dispatch'] === 'string') {
            n.by = seatBy(b['dispatch']);
            edge(n.key, `dispatch:${b['dispatch']}`, 'handed back by');
          }
        } else if (f.event === 'verified') {
          const prod = byKey.get(flowKey(f.mission, f.line, 'product', f.key))?.body['object'];
          const runs = (b['runs'] ?? []) as Json[];
          const n = typeof prod === 'string' ? nodes.get(objKey(prod)) : undefined;
          if (n !== undefined) addCheck(n, `verification ${runs.filter((r) => r['passed'] === true).length}/${runs.length} passed`);
        } else if (f.event === 'accepted' && typeof b['product'] === 'string') {
          const n = nodes.get(objKey(b['product']));
          if (n !== undefined) {
            addCheck(n, `accepted (${String(b['judgment'] ?? '')})`);
            // the acceptance names its judgment; the judgment names its Reviewer dispatch and the runs it cites
            if (typeof b['judgment'] === 'string') edge(n.key, `judgment:${b['judgment']}`, 'accepted by');
          }
        } else if (f.event === 'rebind' && typeof b['product'] === 'string' && typeof b['from'] === 'string') {
          // a kept product re-bound to a later plan (design 4.1 Appendix J): the same candidate, a new version
          // (its predecessor and the plan it relies on are the version record's own edges)
          const n = objNode(b['product'], f.rev);
          n.by = b['how'] === 'carried' ? `the program, re-binding ${b['from']} (nothing its review judged had changed)` : `the program, re-binding ${b['from']} (a Reviewer judges it)`;
        } else if (f.event === 'rebound' && typeof b['product'] === 'string') {
          const n = nodes.get(objKey(b['product']));
          if (n !== undefined) {
            addCheck(n, `accepted (${String(b['judgment'] ?? '')}${b['how'] === 'carried' ? ', the judgment carried over' : ''})`);
            if (typeof b['judgment'] === 'string') edge(n.key, `judgment:${b['judgment']}`, 'accepted by');
          }
        }
      } else if (f.line === SECRETARY_LINE) {
        const id = `${f.mission}/${f.key}`;
        if (f.event === 'escalation') {
          const n = node('escalation', id, f.mission, f.rev, `${String(b['source'] ?? '')}: ${clip(String(b['summary'] ?? b['subject'] ?? ''), 120)}`);
          n.state = 'open';
          n.by = `escalated by ${String(b['source'] ?? 'the program')}`;
          const subject = String(b['subject'] ?? '');
          if (subject.startsWith('plan:') && objects.has(subject.slice(5))) edge(n.key, objKey(subject.slice(5)), 'about');
          else if (typeof b['lineage'] === 'string') {
            const t = [...tasks.entries()].filter(([, x]) => x.row['lineage'] === b['lineage'] && Number(x.row['queued_rev']) <= f.rev).pop();
            if (t !== undefined) edge(n.key, `task:${t[0]}`, 'about');
          }
          for (const line of (b['items'] ?? []) as string[]) {
            const v = versionAt(line, f.rev);
            if (v !== null) edge(n.key, `requirement:${v}`, 'involves');
          }
        } else if (f.event === 'decision' || f.event === 'user-answer') {
          const user = f.event === 'user-answer' || b['by'] === 'user';
          const what = `${String(b['option'] ?? '')}${b['classification'] ? ` (${String(b['classification'])})` : ''}`;
          const text = `${what}: ${clip(String(b['reason'] ?? b['instructions'] ?? ''), 100)}`;
          const earlier = decisionHistory.get(id) ?? [];
          const n = node('decision', id, f.mission, f.rev, text);
          // the latest decision is the one in effect (decisionFor: the user's answer first); earlier ones stay as history
          n.title = earlier.length > 0 ? `${text} (earlier: ${earlier.join('; ')})` : text;
          decisionHistory.set(id, [...earlier, `${user ? 'the user' : `the ${String(b['by'] ?? 'Secretary')}`} chose ${what}`]);
          decisionRev.set(id, f.rev);
          n.leaves.push(...leafOf(f.rev, /decisions\.md#/));
          edge(n.key, `escalation:${id}`, 'decides');
          const esc = nodes.get(`escalation:${id}`);
          if (esc !== undefined) esc.state = `decided: ${String(b['option'] ?? '')}${user ? ' (by the user)' : ''}`;
          // the user's words entry: the answer keeps it at the end of its reason, "<the words> (W-<n>)"
          const w = /\((W-[0-9]+)\)\s*$/.exec(String(b['words'] ?? b['reason'] ?? ''));
          if (user) {
            n.by = `the user${w !== null ? ` (${w[1]})` : ''}, recorded by ${pmBy.get(n.key) ?? 'the PM via `mp pm answer`'}`;
            n.state = 'in effect (the user\'s decision)';
            if (w !== null) {
              node('words', w[1]!, null, 0);
              edge(n.key, `words:${w[1]}`, 'the user decided in');
            }
          } else {
            const t = byKey.get(flowKey(f.mission, SECRETARY_LINE, 'escalation', f.key))?.body['task'];
            const d = typeof t === 'string' ? handingDispatch(t) : null;
            n.by = d !== null ? seatBy(d) : `the ${String(b['by'] ?? 'Secretary')}`;
            if (d !== null) edge(n.key, `dispatch:${d}`, 'handed back by');
            n.state = 'recorded';
          }
        } else if (f.event === 'applied') {
          const n = nodes.get(`decision:${id}`);
          // carried out: the decision in effect when the owning flow applied it
          if (n !== undefined && (decisionRev.get(id) ?? 0) < f.rev) n.state = n.state?.startsWith('in effect') ? 'in effect (the user\'s decision), carried out' : 'carried out';
        }
      } else if (f.line.startsWith('exploration:')) {
        const x = `${f.mission}/${f.line.slice('exploration:'.length)}`;
        if (f.event === 'defined') {
          const def = (b['definition'] ?? {}) as Json;
          const n = node('exploration', x, f.mission, f.rev, clip(String(def['question'] ?? def['goal'] ?? ''), 120));
          n.state = 'defined';
          // the PM plan whose element defines it: the plan in effect that lists it (plan/pm-plan-effective)
          const by = effectivePlans.filter((y) => y.mission === f.mission && y.rev <= f.rev && ((y.body['explorations'] ?? []) as string[]).includes(f.line.slice('exploration:'.length))).pop();
          if (by !== undefined && typeof by.body['plan'] === 'string') edge(n.key, objKey(by.body['plan']), 'defined in');
        } else if (f.event === 'consumed' && typeof b['version'] === 'string' && b['changed'] === true) {
          const n = objNode(b['version'], f.rev);
          n.title ||= `exploration version (${String(b['kind'])})`;
          if (!n.state) n.state = labels.has(b['version']) ? String(labels.get(b['version'])) : 'submitted';
          edge(n.key, `exploration:${x}`, 'version of');
          const d = typeof b['task'] === 'string' ? handingDispatch(b['task']) : null;
          if (d !== null) {
            n.by = seatBy(d);
            edge(n.key, `dispatch:${d}`, 'handed back by');
          }
          n.leaves.push(...leafOf(f.rev, /\/explorations\//));
        } else if (f.event === 'stopped') {
          const n = nodes.get(`exploration:${x}`);
          if (n !== undefined) n.state = `stopped (${String(b['reason'] ?? '')})`;
        } else if (f.event === 'settled') {
          // the latest event is the current state: a settle stands until a rerun reopens the exploration
          const n = nodes.get(`exploration:${x}`);
          if (n !== undefined) n.state = `settled: ${String(b['outcome'] ?? '')} (${String(b['stop'] ?? '')})`;
        } else if (f.event === 'rerun') {
          const n = nodes.get(`exploration:${x}`);
          if (n !== undefined) n.state = 'reopened: its evidence executions run again after an environment change';
        }
      } else if (f.line === REPAIRS_LINE) {
        // 4.1.2 (D-10): a repair the user found, and what it caused
        const id = `${f.mission}/${f.key}`;
        if (f.event === 'repair') {
          const n = node('repair', id, f.mission, f.rev, `${String(b['kind'] ?? '')}: "${clip(String(b['text'] ?? ''), 120)}"`);
          const about = b['about'] as Json | null;
          n.state = about?.['kind'] === 'exploration' ? `reopened exploration ${String(about['id'])} for one more round` : 'recorded: an Architect repair step amends the plan in effect';
          n.by = `the user (${String(b['words'] ?? '')}), recorded by ${pmBy.get(n.key) ?? 'the PM via `mp pm repair`'}`;
          if (typeof b['words'] === 'string') {
            node('words', b['words'], null, 0);
            edge(n.key, `words:${b['words']}`, 'the user said in');
          }
          if (about?.['kind'] === 'exploration') edge(n.key, `exploration:${f.mission}/${String(about['id'])}`, 'reopens');
        } else if (f.event === 'decided') {
          const n = nodes.get(`repair:${id}`);
          if (n !== undefined) {
            const add = (b['add'] ?? []) as string[];
            const reopen = ((b['reopen'] ?? []) as Json[]).map((x) => String(x['task']));
            n.state = `decided: ${add.length > 0 ? `adds ${add.join(', ')}` : 'adds no task'}; ${reopen.length > 0 ? `reopens ${reopen.join(', ')}` : 'reopens no task'} (plan ${String(b['dplan'] ?? '')})`;
            addCheck(n, 'mechanical checks passed (D-10: no Calibrator, no feasibility review)');
            if (typeof b['dplan'] === 'string') edge(n.key, objKey(b['dplan']), 'amends');
          }
        }
      } else if (f.line.startsWith('dispatch:') && f.event === 'refused') {
        const n = nodes.get(`dispatch:${f.line.slice('dispatch:'.length)}`);
        const problems = (b['problems'] ?? []) as string[];
        if (n !== undefined) addCheck(n, `a ${String(b['command'] ?? 'hand-back')} was refused: ${clip(problems.join('; '), 200)}`);
      } else if (f.line.startsWith('delivery:')) {
        if (f.event === 'closing-run' && typeof b['run'] === 'string') {
          // the closing check's run (a flow event, A3): it ran on the delivery candidate
          const n = node('run', String(f.key), f.mission, f.rev, `closing check ${String(b['check'] ?? '')}: ${clip(String(b['command'] ?? ''), 80)}`);
          n.state = b['passed'] === true ? 'passed' : 'failed';
          n.checks = runChecks((b['fields'] ?? {}) as Json);
          n.by = 'mp (closing checks of `mp pm deliver`)';
          n.leaves.push(...leafOf(f.rev, /\/runs\//));
          edge(n.key, `delivery:${f.mission}/${f.line.slice('delivery:'.length)}`, 'closing check of');
        }
      }
    }

    // ---- 4.1.2: the work repairs and integration reviews caused, and products built on a version since replaced
    {
      const repairOf = new Map<string, string>();
      for (const f of flows) {
        if (f.line !== PLAN_LINE || f.event !== 'effective') continue;
        for (const a of (f.body['amendments'] ?? []) as Json[]) for (const t of (a['tasks'] ?? []) as Json[]) repairOf.set(`${f.mission}\n${String(t['id'])}`, String(a['repair']));
      }
      const taskLines = new Map<string, Map<string, Array<{ revision: number; event: string; key: string; body: unknown }>>>();
      for (const f of flows) {
        if (!f.line.startsWith('task:')) continue;
        const m = taskLines.get(f.mission) ?? new Map<string, Array<{ revision: number; event: string; key: string; body: unknown }>>();
        const xs = m.get(f.line.slice('task:'.length)) ?? [];
        xs.push({ revision: f.rev, event: f.event, key: f.key, body: f.body });
        m.set(f.line.slice('task:'.length), xs);
        taskLines.set(f.mission, m);
      }
      for (const [mission, lines] of taskLines) {
        for (const [task, events] of lines) {
          const reworks = new Map(events.filter((e) => e.event === 'rework').map((e) => [e.key, e.body as Json]));
          for (const e of events) {
            if (e.event === 'product') {
              const b = e.body as Json;
              const n = typeof b['object'] === 'string' ? nodes.get(objKey(b['object'])) : undefined;
              if (n === undefined) continue;
              const added = repairOf.get(`${mission}\n${task}`);
              if (added !== undefined && nodes.has(`repair:${mission}/${added}`)) edge(n.key, `repair:${mission}/${added}`, 'added by');
              const rw = reworks.get(e.key);
              const src = (rw?.['reopen'] ?? null) as Json | null;
              if (rw?.['reason'] === 'reopen' && src?.['kind'] === 'repair') {
                addCheck(n, `reopened by repair ${String(src['repair'])}`);
                if (nodes.has(`repair:${mission}/${String(src['repair'])}`)) edge(n.key, `repair:${mission}/${String(src['repair'])}`, 'answers');
              } else if (rw?.['reason'] === 'reopen' && src?.['kind'] === 'review') addCheck(n, `reopened by the review ${String(src['review'])} of integration task ${String(src['integration'])}`);
              if (b['noConstructor'] === true || events.some((d) => d.event === 'dispatched' && d.key === b['task'] && (d.body as Json)['noConstructor'] === true)) addCheck(n, 'the start snapshot of an integration task that writes nothing (no Constructor)');
            } else if (e.event === 'reopen') {
              const b = e.body as Json;
              const prod = (events.find((x) => x.event === 'product' && x.key === e.key)?.body as Json | undefined)?.['object'];
              const n = typeof prod === 'string' ? nodes.get(objKey(prod)) : undefined;
              if (n !== undefined) addCheck(n, `its review ${String(b['review'])} reopened ${((b['tasks'] ?? []) as Json[]).map((x) => `${String(x['task'])} (attempt ${String(x['attempt'])})`).join(', ')}`);
            }
          }
          // an accepted product built on a version its dependency has since replaced: said, never rebuilt (no cascade)
          const now = lineAcceptance(events);
          if (now.product === null) continue;
          const n = nodes.get(objKey(now.product));
          if (n === undefined) continue;
          for (const o of builtOnOlder(list(objects.get(now.product)?.['prerequisites']), lines)) {
            addCheck(n, `built on ${o.prerequisite} (task ${o.task}, attempt ${o.attempt}); ${o.task} has a newer accepted version ${o.newer} (not rebuilt: the integration's full run checks the combination)`);
          }
        }
      }
    }

    // ---- who handed each task over (its first task.queued record's queuedBy), and what it works on (its spec)
    const queuedBy = new Map<string, Json>();
    for (const r of db.stmt("SELECT record FROM log WHERE kind = 'task.queued' ORDER BY rev").all() as Array<{ record: string }>) {
      const rec = JSON.parse(r.record) as Json;
      if (!queuedBy.has(String(rec['task'])) && rec['queuedBy'] !== undefined && rec['queuedBy'] !== null) queuedBy.set(String(rec['task']), rec['queuedBy'] as Json);
    }
    for (const [task, { row, spec }] of tasks) {
      const n = nodes.get(`task:${task}`)!;
      const card = (spec?.['card'] ?? {}) as Json;
      const ups: Array<{ key: string; rel: string }> = [];
      const output = typeof card['output']?.['object'] === 'string' ? card['output']['object'] : null;
      const h = queuedBy.get(task) ?? null;
      if (h !== null) {
        for (const o of (h['objects'] ?? []) as string[]) if (o !== output && objects.has(o)) ups.push({ key: objKey(o), rel: 'works on' });
        if (typeof h['dispatch'] === 'string' && dispatches.has(h['dispatch'])) ups.push({ key: `dispatch:${h['dispatch']}`, rel: 'handed over by' });
        else if (typeof h['task'] === 'string' && tasks.has(h['task'])) ups.push({ key: `task:${h['task']}`, rel: 'handed over by' });
      }
      if (card['pmPlan'] && typeof card['pmPlan']['object'] === 'string') ups.push({ key: objKey(card['pmPlan']['object']), rel: 'decomposes' });
      for (const b of (spec?.['binds'] ?? []) as string[]) if (b !== output) ups.push({ key: objKey(b), rel: 'works on' });
      const target = typeof card['target'] === 'string' ? card['target'] : typeof card['target']?.['id'] === 'string' ? card['target']['id'] : null;
      if (target !== null && objects.has(target)) ups.push({ key: objKey(target), rel: 'works on' });
      const ex = card['exploration']?.['id'];
      if (typeof ex === 'string') ups.push({ key: `exploration:${row['mission']}/${ex}`, rel: 'works on' });
      for (const f of escalationsOfTask.get(task) ?? []) ups.push({ key: `escalation:${f.mission}/${f.key}`, rel: 'decides' });
      const prev = card['continuation']?.['previous'];
      if (typeof prev === 'string' && dispatches.has(prev)) ups.push({ key: `dispatch:${prev}`, rel: 'continues' });
      // the constructor's detailed plan (task line 'dispatched') is linked above; its requirement items:
      for (const it of (card['requirementItems'] ?? []) as Json[]) {
        const line = typeof it === 'string' ? it : it?.['id'];
        if (typeof line !== 'string') continue;
        const v = versionAt(line, Number(row['queued_rev']));
        if (v !== null) ups.push({ key: `requirement:${v}`, rel: 'serves' });
      }
      for (const u of ups) if (nodes.has(u.key)) edge(n.key, u.key, u.rel);
      if (h !== null) {
        const d = typeof h['dispatch'] === 'string' ? h['dispatch'] : null;
        n.by = `queued by mp: ${clip(String(h['step'] ?? ''), 160)}${d !== null ? ` (handed over by ${seatBy(d)})` : ''}`;
      } else {
        const first = (out.get(n.key) ?? [])[0];
        if (first !== undefined) {
          const up = nodes.get(first.to)!;
          n.by = `queued by mp from ${KIND_LABEL[up.kind]} ${up.id}${up.by !== null && up.kind !== 'requirement' ? ` (${up.by})` : ''}`;
        }
      }
    }

    // ---- judgments
    const judgmentRows = db.stmt("SELECT rev, op, record FROM log WHERE kind = 'judgment' ORDER BY rev").all() as Array<{ rev: number; op: string | null; record: string }>;
    const jids: string[] = [];
    const runIds = new Set<string>();
    for (const r of judgmentRows) {
      const rec = JSON.parse(r.record) as Json;
      const target = String(rec['target']);
      if (only !== null && !objects.has(target) && !handedIn.has(String(rec['judgment']))) continue;
      const n = node('judgment', String(rec['judgment']), objects.get(target)?.['mission'] ?? null, Number(r.rev), `${String(rec['review'])} of ${target} by the ${String(rec['executor'])}`);
      n.state = String(rec['verdict']);
      jids.push(n.id);
      // the dispatch whose accepted hand-back committed this very record: its write's operation is that hand-back's
      const accepted = handedIn.get(n.id) ?? null;
      const d = accepted !== null && r.op === `handback:${accepted}` ? accepted : null;
      n.by = d !== null ? seatBy(d) : `the ${String(rec['executor'])}`;
      if (d !== null) edge(n.key, `dispatch:${d}`, 'handed back by');
      // a ruling (j.sec.<escalation>, j.user.<escalation>) is written by the flow in the write that carries
      // its decision out: it is credited to that decision, and so to who decided (the Secretary's dispatch, the user's words)
      const ruling = /^j\.(?:sec|user)\.(.+)$/.exec(n.id);
      const decision = ruling === null ? undefined : [...nodes.values()].find((x) => x.kind === 'decision' && x.id.endsWith(`/${ruling[1]}`));
      if (decision !== undefined) {
        n.by = `${decision.by ?? `the ${String(rec['executor'])}`}; written when the decision was carried out`;
        edge(n.key, decision.key, 'carries out');
      }
      edge(n.key, objKey(target), 'judges');
      for (const e of list(rec['evidence'])) {
        runIds.add(e);
        edge(n.key, `run:${e}`, 'cites');
      }
      for (const bv of list(rec['bases'])) if (nodes.has(`requirement:${bv}`)) edge(n.key, `requirement:${bv}`, 'based on');
      for (const x of list(rec['reliesOn'])) if (objects.has(x)) edge(n.key, objKey(x), 'relies on');
    }
    if (jids.length > 0) {
      try {
        const cur = judgmentStates(db, jids).current;
        for (const id of jids) {
          const n = nodes.get(`judgment:${id}`)!;
          const c = cur[id];
          n.state = `${n.state}${c === true ? ', current' : c === false ? ', not current' : ''}`;
        }
      } catch {
        /* currency unknown: the verdict alone */
      }
    }

    // ---- runs (evidence records)
    for (const r of db.stmt("SELECT rev, op, record FROM log WHERE kind = 'evidence' ORDER BY rev").all() as Array<{ rev: number; op: string | null; record: string }>) {
      const rec = JSON.parse(r.record) as Json;
      const fields = (rec['fields'] ?? {}) as Json;
      const id = String(rec['evidence']);
      const obj = typeof fields['object'] === 'string' ? fields['object'] : null;
      const del = typeof fields['delivery'] === 'string' ? fields['delivery'] : null;
      const disp = typeof fields['dispatch'] === 'string' ? fields['dispatch'] : null;
      const belongs = only === null || (obj !== null && objects.has(obj)) || runIds.has(id) || (disp !== null && dispatches.has(disp)) || nodes.has(`run:${id}`);
      if (!belongs) continue;
      const n = node('run', id, obj !== null ? (objects.get(obj)?.['mission'] ?? null) : null, Number(r.rev));
      n.title ||= `${String(rec['runClass'])} run: ${clip(String(fields['command'] ?? ''), 80)}`;
      n.state = fields['status'] === 'completed' && String(fields['exit']) === '0' ? 'passed' : `failed (${String(fields['status'] ?? '?')}, exit ${String(fields['exit'] ?? '?')})`;
      n.checks = runChecks(fields);
      n.by = disp !== null ? `mp, rerun by dispatch ${disp}` : del !== null ? 'mp (closing checks)' : `mp (${String(fields['purpose'] ?? 'declared run')})`;
      if (r.op !== null) n.leaves.push(...(leavesByOp.get(r.op) ?? []).filter((l) => /\/runs\//.test(l)));
      if (obj !== null && objects.has(obj)) edge(n.key, objKey(obj), 'verifies');
      else if (typeof fields['candidate'] === 'string') {
        const c = node('commit', fields['candidate'], n.mission, Number(r.rev), 'a commit a run checked out');
        edge(n.key, c.key, 'ran on');
      }
      if (disp !== null && dispatches.has(disp)) edge(n.key, `dispatch:${disp}`, 'rerun by');
    }

    // ---- deliveries and landings
    const dels = only === null ? db.stmt('SELECT * FROM deliveries ORDER BY seq').all() : db.stmt('SELECT * FROM deliveries WHERE mission = ? ORDER BY seq').all(only);
    const deliveryOps = new Map<number, string>();
    for (const r of db.stmt("SELECT rev, op FROM log WHERE kind = 'delivery.recorded' AND op IS NOT NULL").all() as Array<{ rev: number; op: string }>) deliveryOps.set(Number(r.rev), r.op);
    const refOnly = new Set<string>();
    for (const r of db.stmt("SELECT args FROM pm_actions WHERE command = 'land' AND state = 'done'").all() as Array<{ args: string }>) {
      const a = parse(r.args)?.['args'] as Json | undefined;
      if (a?.['flags']?.['deliver-ref-only'] === true) refOnly.add(String(a['positionals']?.[0] ?? ''));
    }
    for (const r of dels as Json[]) {
      const id = `${String(r['mission'])}/${String(r['delivery'])}`;
      const doc = parse(r['manifest']);
      const n = node('delivery', id, String(r['mission']), Number(r['seq']), `delivery ${String(r['delivery'])} of mission ${String(r['mission'])} to ${String(r['target'] ?? doc?.['targetBranch'] ?? '?')}`);
      n.state = String(r['state']);
      n.by = pmBy.get(n.key) ?? 'the PM via `mp pm deliver`';
      const op = r['recorded_rev'] === null ? undefined : deliveryOps.get(Number(r['recorded_rev']));
      if (op !== undefined) n.leaves.push(...(leavesByOp.get(op) ?? []).filter((l) => /\/deliveries\//.test(l)));
      if (refOnly.has(String(r['delivery']))) n.state += ', delivered as a ref only';
      const checks = (doc?.['checks'] ?? []) as Json[];
      if (checks.length > 0) n.checks = `closing checks ${checks.filter((c) => c['passed'] === true).length}/${checks.length} passed`;
      for (const s of (doc?.['selected'] ?? []) as Json[]) {
        const t = String(s['id'] ?? '');
        if (objects.has(t)) edge(n.key, objKey(t), 'delivers');
      }
      for (const e of (doc?.['entries'] ?? []) as Json[]) if (objects.has(String(e['id']))) edge(n.key, objKey(String(e['id'])), 'delivers');
      if (typeof doc?.['words'] === 'string') {
        node('words', doc['words'], null, 0);
        edge(n.key, `words:${doc['words']}`, 'asked for in');
      }
      if (typeof doc?.['rebuildOf'] === 'string') edge(n.key, `delivery:${String(r['mission'])}/${doc['rebuildOf']}`, 'rebuilds');
      const c = node('commit', String(r['commit_id']), String(r['mission']), Number(r['seq']), `the delivery commit of ${id}`);
      edge(c.key, n.key, 'is the delivery commit of');
    }
    const intents = db.stmt("SELECT * FROM intents WHERE kind = 'landing' ORDER BY updated_at").all() as Json[];
    for (const i of intents) {
      const det = parse(i['details']);
      const dl = (() => {
        try {
          return JSON.parse(String(i['delivery'] ?? 'null')) as Json | null;
        } catch {
          return null;
        }
      })();
      if (dl === null || !inMission(String(dl['mission']))) continue;
      const n = node('landing', String(i['intent']), String(dl['mission']), 0, `landing of ${String(dl['op'])} on ${String(det?.['branch'] ?? dl['targetBranch'] ?? '?')}: ${short(String(det?.['base'] ?? dl['base']))} → ${short(String(dl['commit']))}`);
      n.state = i['state'] === 'done' ? 'landed' : i['state'] === 'failed' ? 'closed, not landed' : 'open';
      n.by = pmBy.get(n.key) ?? 'the PM via `mp pm land`';
      edge(n.key, `delivery:${String(dl['mission'])}/${String(dl['op'])}`, 'lands');
      if (typeof det?.['words'] === 'string') {
        node('words', det['words'], null, 0);
        edge(n.key, `words:${det['words']}`, 'consented in');
      }
      const dn = nodes.get(`delivery:${String(dl['mission'])}/${String(dl['op'])}`);
      if (dn !== undefined && i['state'] === 'done') dn.state = `${dn.state}, landed`;
    }

    // ---- stops
    for (const r of db.stmt('SELECT * FROM stops ORDER BY committed_at').all() as Json[]) {
      const scope = JSON.parse(String(r['scope'])) as Json;
      const m = scope['kind'] === 'mission' ? String(scope['mission']) : null;
      if (only !== null && m !== null && m !== only) continue;
      const n = node('stop', String(r['stop']), m, 0, `${scope['kind'] === 'all' ? 'everything' : scope['kind'] === 'mission' ? `mission ${String(scope['mission'])}` : `capability ${String(scope['capability'])}`}: "${clip(String(r['words']), 80)}"`);
      n.state = String(r['state']);
      n.by = pmBy.get(n.key) ?? 'the PM via `mp pm stop`';
      if (typeof r['words_entry'] === 'string') {
        node('words', r['words_entry'], null, 0);
        edge(n.key, `words:${r['words_entry']}`, 'stopped in');
      }
    }

    // words referenced but not recorded here (another copy's)
    for (const n of nodes.values()) if (n.kind === 'words' && n.title === '') n.title = '(not in this memory)';
    // the handover first: what each node rests on, in the order of the run chain (§3.2 item 1)
    for (const [k, xs] of out) out.set(k, [...xs].sort((a, b) => relRank(a.rel) - relRank(b.rel)));
    return { nodes, out, inn, recomputing };
  });
}

/**
 * The order in which a node's "rests on" links are read: who handed it over first (the run chain),
 * then what it was made for, the words, and the review links last. The first one that keeps the
 * tree free of cycles is the node's place in `mp read tree`.
 */
const REL_ORDER: readonly string[] = [
  'handed back by',
  'claimed',
  'is the candidate of',
  'is the delivery commit of',
  'lands',
  'closing check of',
  'verifies',
  'rerun by',
  'collected from',
  'ran on',
  'decides',
  'planned in',
  'decomposes',
  'works on',
  'continues',
  'handed over by',
  'accepted by',
  'delivers',
  'version of',
  'rebuilds',
  'judges',
  'about',
  'quotes',
  'asked for in',
  'consented in',
  'the user decided in',
  'stopped in',
  'defined in',
  'rests on authorization',
  'relies on',
  'requires',
  'revises',
  'based on',
  'serves',
  'cites',
  'involves',
];

function relRank(rel: string): number {
  const i = REL_ORDER.findIndex((r) => rel === r || rel.startsWith(`${r} `));
  return i < 0 ? REL_ORDER.length : i;
}

function addCheck(n: GNode, c: string): void {
  n.checks = n.checks === null ? c : `${n.checks}; ${c}`;
}

function runChecks(fields: Json): string {
  const tests = fields['tests'] !== undefined ? `${Number(fields['tests']) - Number(fields['testsFailed'] ?? 0)}/${String(fields['tests'])} tests passed` : null;
  return [`exit ${String(fields['exit'] ?? '?')}`, tests].filter((x) => x !== null).join(', ');
}

function targetOfTask(tasks: Map<string, { spec: Json | null }>, task: string): string | null {
  const s = tasks.get(task)?.spec;
  const b = (s?.['binds'] ?? []) as string[];
  return b[0] ?? null;
}

/** The node keys a PM command's recorded result names (so a node shows which PM command made it). */
export function pmResultKeys(command: string, j: Json): string[] {
  const keys: string[] = [];
  const s = (x: unknown): x is string => typeof x === 'string' && x !== '';
  if (command === 'say' && s(j['words'])) keys.push(`words:${j['words']}`);
  if (command === 'requirement add' && s(j['version'])) keys.push(`requirement:${j['version']}`);
  if (command === 'constraint add' && s(j['version'])) keys.push(`constraint:${j['version']}`);
  if (command === 'plan submit' && s(j['plan'])) keys.push(`plan:${j['plan']}`);
  if (command === 'dispatch' && s(j['dispatch'])) keys.push(`dispatch:${j['dispatch']}`);
  if (command === 'deliver' && s(j['mission']) && s(j['delivery'])) keys.push(`delivery:${j['mission']}/${j['delivery']}`);
  if (command === 'land' && s(j['intent'])) keys.push(`landing:${j['intent']}`);
  if (command === 'stop' && s(j['stop'])) keys.push(`stop:${j['stop']}`);
  if (command === 'answer' && s(j['mission']) && s(j['escalation'])) keys.push(`decision:${j['mission']}/${j['escalation']}`);
  return keys;
}

// ---------------------------------------------------------------- finding a node

/** The nodes an id names: a key ("kind:id"), an id of any node, a requirement line, a commit (or anything git resolves to one). */
export function resolveNodes(g: Graph, ctx: ProcessContext, raw: string, kinds?: readonly NodeKind[]): GNode[] {
  const id = raw.trim();
  const direct = g.nodes.get(id);
  if (direct !== undefined) return [direct];
  const byId = [...g.nodes.values()].filter((n) => (kinds === undefined || kinds.includes(n.kind)) && (n.id === id || (n.kind === 'delivery' && n.id.endsWith(`/${id}`)) || ((n.kind === 'escalation' || n.kind === 'decision' || n.kind === 'exploration' || n.kind === 'repair') && n.id.endsWith(`/${id}`))));
  if (byId.length > 0) return byId.filter((n) => n.kind !== 'decision' || !byId.some((x) => x.kind === 'escalation'));
  // a requirement line: its latest version
  const versions = [...g.nodes.values()].filter((n) => n.kind === 'requirement' && n.id.startsWith(`${id}.v`));
  if (versions.length > 0) return [versions.sort((a, b) => b.rev - a.rev)[0]!];
  // a commit: a prefix, or what git resolves (a branch, HEAD)
  let sha: string | null = /^[0-9a-f]{7,64}$/i.test(id) ? id.toLowerCase() : null;
  const commits = (s: string): GNode[] => [...g.nodes.values()].filter((n) => n.kind === 'commit' && n.id.startsWith(s));
  if (sha !== null && commits(sha).length > 0) return commits(sha);
  const r = ctx.git.runSync(['rev-parse', '--verify', '--quiet', '--end-of-options', `${id}^{commit}`], { cwd: ctx.projectDir });
  if (r.code === 0) {
    sha = r.stdout.toString('utf8').trim();
    if (commits(sha).length > 0) return commits(sha);
  }
  return [];
}

// ---------------------------------------------------------------- display

export interface Shown {
  readonly key: string;
  readonly kind: NodeKind;
  readonly id: string;
  readonly mission: string | null;
  readonly title: string;
  readonly state: string | null;
  readonly checks: string | null;
  readonly by: string | null;
  readonly leaves: ReadonlyArray<{ readonly leaf: string; readonly path: string; readonly status: 'ok' | 'missing' | 'edited' | 'unrecorded' }>;
}

/** A node as shown: leaves hash-checked now, a commit checked for reachability here. */
export function show(ctx: ProcessContext, n: GNode, cache: Map<string, Shown> = new Map()): Shown {
  const hit = cache.get(n.key);
  if (hit !== undefined) return hit;
  const leaves = n.leaves.map((leaf) => {
    const r = ctx.memory.readLeaf(leaf);
    const file = r?.file ?? leaf.split('#')[0]!;
    return { leaf, path: `.mission-pipeline/${file}${r?.anchor ? `#${r.anchor}` : ''}`, status: (r === null ? 'unrecorded' : r.status) as 'ok' | 'missing' | 'edited' | 'unrecorded' };
  });
  let state = n.state;
  if (n.kind === 'commit') {
    const r = ctx.git.runSync(['cat-file', '-e', `${n.id}^{commit}`], { cwd: ctx.projectDir });
    state = r.code === 0 ? 'in the repository' : 'commit not reachable here';
  }
  const s: Shown = { key: n.key, kind: n.kind, id: n.id, mission: n.mission, title: n.title, state, checks: n.checks, by: n.by, leaves };
  cache.set(n.key, s);
  return s;
}

function head(s: Shown): string {
  const id = s.kind === 'commit' ? short(s.id) : s.id;
  return `${KIND_LABEL[s.kind]} ${id}${s.title !== '' ? ` — ${s.title}` : ''}`;
}

function detail(s: Shown): string {
  const leaf = s.leaves.map((l) => `${l.path}${l.status === 'ok' ? '' : l.status === 'missing' ? ' (leaf missing)' : l.status === 'edited' ? ' (leaf edited after it was recorded)' : ' (not recorded)'}`).join(', ');
  return [s.state !== null ? `state: ${s.state}` : null, s.checks !== null ? `checks: ${s.checks}` : null, s.by !== null ? `by: ${s.by}` : null, leaf !== '' ? `leaf: ${leaf}` : null].filter((x) => x !== null).join(' · ');
}

export interface Walk {
  readonly text: string;
  readonly json: unknown;
}

/**
 * `why` (direction back: what each node rests on, down to the maintainer's words) and `from`
 * (direction forward: everything that rests on it). Each node once; a node met again is named
 * "(shown above)". At most `max` nodes.
 */
export function walk(ctx: ProcessContext, g: Graph, starts: readonly GNode[], direction: 'back' | 'forward', max = 400): Walk {
  const cache = new Map<string, Shown>();
  const seen = new Set<string>();
  const lines: string[] = [];
  const edges: GEdge[] = [];
  let truncated = false;
  const visit = (key: string, depth: number, via: string | null): void => {
    const n = g.nodes.get(key);
    if (n === undefined) return;
    const s = show(ctx, n, cache);
    const pad = '  '.repeat(depth);
    const lead = via === null ? '' : `${via}: `;
    if (seen.has(key)) {
      lines.push(`${pad}${lead}${KIND_LABEL[s.kind]} ${s.kind === 'commit' ? short(s.id) : s.id} (shown above)`);
      return;
    }
    if (seen.size >= max) {
      truncated = true;
      return;
    }
    seen.add(key);
    lines.push(`${pad}${lead}${head(s)}`);
    const d = detail(s);
    if (d !== '') lines.push(`${pad}    ${d}`);
    const next = direction === 'back' ? (g.out.get(key) ?? []).map((e) => ({ e, to: e.to })) : [...(g.inn.get(key) ?? [])].sort((a, b) => relRank(a.rel) - relRank(b.rel)).map((e) => ({ e, to: e.from }));
    for (const x of next) {
      edges.push(x.e);
      visit(x.to, depth + 1, direction === 'back' ? `← ${x.e.rel}` : `→ (it ${x.e.rel} this)`);
    }
  };
  for (const s of starts) visit(s.key, 0, null);
  if (truncated) lines.push(`… (more than ${max} nodes: narrow the start)`);
  const reachesWords = direction === 'back' ? [...seen].some((k) => k.startsWith('words:')) : null;
  if (direction === 'back' && reachesWords === false) lines.push('(this walk does not reach the maintainer\'s words: the start rests on nothing recorded that goes back to them)');
  return { text: lines.join('\n'), json: { direction, starts: starts.map((s) => s.key), nodes: [...seen].map((k) => cache.get(k)), edges: dedupeEdges(edges), truncated, reachesWords } };
}

function dedupeEdges(es: readonly GEdge[]): GEdge[] {
  const m = new Map<string, GEdge>();
  for (const e of es) m.set(canonicalJson([e.from, e.to, e.rel]), e);
  return [...m.values()];
}

/** `mp read chain <dispatch>`: one dispatch with its card, the step that handed it over, its report, checks and what it led to. */
export function chain(ctx: ProcessContext, g: Graph, dispatch: string): Walk | null {
  const n = g.nodes.get(`dispatch:${dispatch}`);
  if (n === undefined) return null;
  const cache = new Map<string, Shown>();
  const s = show(ctx, n, cache);
  const task = (g.out.get(n.key) ?? []).find((e) => e.rel === 'claimed');
  const t = task === undefined ? null : g.nodes.get(task.to) ?? null;
  const handedOver = t === null ? [] : (g.out.get(t.key) ?? []).map((e) => ({ rel: e.rel, node: show(ctx, g.nodes.get(e.to)!, cache) }));
  const ledTo = (g.inn.get(n.key) ?? []).map((e) => g.nodes.get(e.from)!).filter((x) => x !== undefined);
  const next: Array<{ via: string; node: Shown; then: Shown[] }> = ledTo.map((x) => ({
    via: (g.inn.get(n.key) ?? []).find((e) => e.from === x.key)!.rel,
    node: show(ctx, x, cache),
    then: (g.inn.get(x.key) ?? []).map((e) => show(ctx, g.nodes.get(e.from)!, cache)),
  }));
  const runs = (g.inn.get(n.key) ?? []).filter((e) => e.rel === 'rerun by').length;
  const card = s.leaves.find((l) => l.leaf.endsWith('/card.md'));
  const report = s.leaves.find((l) => l.leaf.endsWith('/report.md'));
  const leafLine = (l: Shown['leaves'][number] | undefined): string => (l === undefined ? 'none' : `${l.path}${l.status === 'ok' ? '' : ` (${l.status === 'missing' ? 'leaf missing' : l.status === 'edited' ? 'leaf edited after it was recorded' : 'not recorded'})`}`);
  const lines = [
    `Dispatch ${dispatch}: ${s.title}`,
    `  state: ${s.state ?? '-'}${s.checks !== null ? ` · checks: ${s.checks}` : ''}`,
    `  dispatched by: ${s.by ?? '-'}`,
    `  card: ${leafLine(card)}`,
    `  report: ${leafLine(report)}`,
    ...(t === null ? [] : [`  task: ${head(show(ctx, t, cache))}`]),
    '  handed over by:',
    ...(handedOver.length === 0 ? ['    (nothing recorded)'] : handedOver.map((h) => `    ${h.rel}: ${head(h.node)}${h.node.by !== null ? ` (by: ${h.node.by})` : ''}`)),
    ...(runs > 0 ? [`  runs it had mp rerun: ${runs}`] : []),
    '  led to:',
    ...(next.length === 0 ? ['    (nothing yet)'] : next.flatMap((x) => [`    ${x.via}: ${head(x.node)}${x.node.state !== null ? ` [${x.node.state}]` : ''}`, ...x.then.map((y) => `      → ${head(y)}${y.state !== null ? ` [${y.state}]` : ''}`)])),
  ];
  return { text: lines.join('\n'), json: { dispatch: s, task: t === null ? null : show(ctx, t, cache), handedOverBy: handedOver.map((h) => ({ rel: h.rel, node: h.node })), ledTo: next } };
}

/** The kinds in the order a mission's tree is read (words → requirements → plans → tasks → dispatches → candidates → judgments → deliveries). */
const LAYER: Readonly<Record<NodeKind, number>> = {
  mission: 0,
  words: 1,
  stop: 2,
  requirement: 2,
  constraint: 2,
  repair: 2,
  exploration: 3,
  plan: 3,
  escalation: 4,
  task: 4,
  dispatch: 5,
  decision: 6,
  object: 6,
  commit: 7,
  judgment: 7,
  run: 8,
  delivery: 9,
  landing: 10,
};

/** `mp read tree <mission>`: one indented tree, one line per node with its state and check result. */
export function tree(ctx: ProcessContext, g: Graph, mission: string): Walk {
  // the mission's nodes, and the words they rest on
  const member = (n: GNode): boolean => n.mission === mission || (n.kind === 'words' && (g.inn.get(n.key) ?? []).some((e) => g.nodes.get(e.from)?.mission === mission)) || (n.kind === 'judgment' || n.kind === 'run' ? (g.out.get(n.key) ?? []).some((e) => g.nodes.get(e.to)?.mission === mission) : false);
  const keys = [...g.nodes.values()].filter(member).map((n) => n.key);
  const inTree = new Set(keys);
  // the primary parent: the first "rests on" link, in the run chain's order, that makes no cycle
  const parent = new Map<string, string>();
  for (const k of keys) {
    const cands = (g.out.get(k) ?? []).filter((e) => inTree.has(e.to));
    for (const e of cands) {
      let x: string | undefined = e.to;
      let loop = false;
      for (let i = 0; x !== undefined && i < 10_000; i++) {
        if (x === k) {
          loop = true;
          break;
        }
        x = parent.get(x);
      }
      if (!loop) {
        parent.set(k, e.to);
        break;
      }
    }
  }
  const children = new Map<string, string[]>();
  for (const [c, p] of parent) children.set(p, [...(children.get(p) ?? []), c]);
  const order = (a: string, b: string): number => {
    const x = g.nodes.get(a)!;
    const y = g.nodes.get(b)!;
    return LAYER[x.kind] - LAYER[y.kind] || x.rev - y.rev || a.localeCompare(b);
  };
  const roots = keys.filter((k) => !parent.has(k)).sort(order);
  const cache = new Map<string, Shown>();
  const lines: string[] = [`mission ${mission}`];
  const nested = (k: string, depth: number): unknown => {
    const s = show(ctx, g.nodes.get(k)!, cache);
    const others = (g.out.get(k) ?? []).filter((e) => e.to !== parent.get(k) && inTree.has(e.to)).map((e) => `${e.rel} ${g.nodes.get(e.to)!.kind === 'commit' ? short(g.nodes.get(e.to)!.id) : g.nodes.get(e.to)!.id}`);
    const leafFlag = s.leaves.some((l) => l.status === 'missing') ? ' (leaf missing)' : s.leaves.some((l) => l.status === 'edited') ? ' (leaf edited)' : '';
    lines.push(`${'  '.repeat(depth)}- ${head(s)}${s.state !== null ? ` [${s.state}]` : ''}${s.checks !== null ? ` {${s.checks}}` : ''}${leafFlag}${others.length > 0 ? ` (also: ${others.slice(0, 4).join('; ')}${others.length > 4 ? '; …' : ''})` : ''}`);
    const kids = (children.get(k) ?? []).sort(order);
    return { node: s, also: others, children: kids.map((c) => nested(c, depth + 1)) };
  };
  const json = roots.map((r) => nested(r, 1));
  return { text: lines.join('\n'), json: { mission, tree: json, nodes: keys.length } };
}

export type { MissionId };
