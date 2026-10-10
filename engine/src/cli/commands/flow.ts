// The PM's decision-layer commands (design 9.2: requirement items and plans, legalization;
// 3.1, 3.3, 3.8, 4.3, 9.5, 11.1). They record ledger facts through the flow functions
// (adapters/flow.ts); the scheduler's flow engine carries them on.

import { readFileSync } from 'node:fs';
import { DECISION_OPTIONS, type DecisionOption } from '../../seat/cards/secretary.ts';
import { ITEM_ID } from '../../common/ids.ts';
import { itemLine, type ItemSource } from '../../flow/requirements.ts';
import { flagList, flagStr, missionArg, positional, type ParsedArgs } from '../args.ts';
import type { Command } from '../command.ts';
import { ok } from '../command.ts';
import type { Ctx } from '../context.ts';
import { CliError, EXIT, usage } from '../errors.ts';
import { shortHash } from '../ops.ts';
import { flowAdapter, type ItemType } from '../adapters/flow.ts';

const TYPES: readonly ItemType[] = ['goal', 'limit', 'authorization', 'acceptance', 'decision'];

/** The booked user message a requirement quotes: --message <id>, or the latest booked one ("latest", the default). */
async function messageOf(ctx: Ctx, flag: string | null): Promise<string> {
  if (flag !== null && flag !== 'latest') return flag;
  const w = (await ctx.call('latestUserWords', { limit: 1 })) as Array<{ message: string }>;
  if (w[0] === undefined) throw new CliError('NO_USER_WORDS', 'no user message is booked yet: a requirement item must quote the user (3.1)', { exitCode: EXIT.REFUSED });
  return w[0].message;
}

export const requirementCmd: Command = {
  name: 'requirement',
  summary: 'requirement items: record one with its source in the user\'s words, or withdraw one (3.1)',
  usage:
    'mp requirement add <mission> <item> --type goal|limit|authorization|acceptance|decision --text "<item>" (--quote "<the user\'s words>" [--message <message id>|latest] | --authorization <authorization item>) [--restatement "<PM restatement>"] [--confirmed-by <message id>] | mp requirement withdraw <mission> <item> --reason "<the user\'s words>"',
  flags: { type: 'string', text: 'string', quote: 'string', message: 'string', authorization: 'string', restatement: 'string', 'confirmed-by': 'string', reason: 'string' },
  changesState: true,
  async run(ctx, args) {
    const sub = positional(args, 0, 'add or withdraw');
    const mission = missionArg(args, 1);
    const item = positional(args, 2, 'item');
    if (sub === 'withdraw') {
      const reason = flagStr(args, 'reason');
      if (reason === null) throw usage('--reason: the user\'s words withdrawing it');
      const r = await flowAdapter().withdrawRequirement(ctx, { mission, item, reason });
      return ok(r.text, r.json);
    }
    if (sub !== 'add') throw usage('requirement takes add or withdraw');
    const type = flagStr(args, 'type');
    if (type === null || !TYPES.includes(type as ItemType)) throw usage(`--type is one of ${TYPES.join(', ')}`);
    const text = flagStr(args, 'text');
    if (text === null || text.trim() === '') throw usage('--text is the item');
    const quote = flagStr(args, 'quote');
    const auth = flagStr(args, 'authorization');
    let source: ItemSource;
    // the authorization item's id (or its line, item.<mission>.<id>)
    if (auth !== null) source = { kind: 'authorization', line: ITEM_ID.test(auth) ? itemLine(mission, auth) : auth };
    else if (quote !== null) source = { kind: 'words', message: await messageOf(ctx, flagStr(args, 'message')), quote };
    else throw usage('every item points to its source (3.1): --quote "<the user\'s words>" (decisions: --authorization <authorization item>)');
    const r = await flowAdapter().addRequirement(ctx, { mission, item, type: type as ItemType, text, source, restatement: flagStr(args, 'restatement'), confirmedBy: flagStr(args, 'confirmed-by') });
    return ok(r.text, r.json);
  },
};

export const constraintCmd: Command = {
  name: 'constraint',
  summary: 'project constraints (9.5): an object constraint (a proof duty) or an execution instruction, with its scope',
  usage: 'mp constraint add <mission> <constraint> --kind object|instruction --text "<constraint>" [--paths <pattern,...>] [--task-types <type,...>]',
  flags: { kind: 'string', text: 'string', paths: 'list', 'task-types': 'list' },
  changesState: true,
  async run(ctx, args) {
    if (positional(args, 0, 'add') !== 'add') throw usage('constraint takes add');
    const kind = flagStr(args, 'kind');
    if (kind !== 'object' && kind !== 'instruction') throw usage('--kind is object or instruction (when unsure: object, 9.5)');
    const text = flagStr(args, 'text');
    if (text === null || text.trim() === '') throw usage('--text is the constraint');
    const paths = flagList(args, 'paths');
    const r = await flowAdapter().addConstraint(ctx, { mission: missionArg(args, 1), constraint: positional(args, 2, 'constraint'), kind, text, paths: paths.length > 0 ? paths : ['**'], taskTypes: flagList(args, 'task-types') });
    return ok(r.text, r.json);
  },
};

export const planCmd: Command = {
  name: 'plan',
  summary: 'PM plan: submit one alignment batch (results level; explorations are plan elements); Calibrator 1 checks it next (3.3)',
  usage: 'mp plan submit <mission> --file <plan.json> [--words <message id,...>] [--changed <item,...>] [--dependent <item,...>] [--mode stable|fast]',
  flags: { file: 'string', words: 'list', changed: 'list', dependent: 'list', mode: 'string' },
  changesState: true,
  identity: (a: ParsedArgs) => ({ positionals: a.positionals, flags: a.flags, plan: (() => {
    try {
      return shortHash(readFileSync(String(a.flags['file'] ?? ''), 'utf8'), 32);
    } catch {
      return null;
    }
  })() }),
  async run(ctx, args) {
    if (positional(args, 0, 'submit') !== 'submit') throw usage('plan takes submit');
    const mission = missionArg(args, 1);
    const file = flagStr(args, 'file');
    if (file === null) throw usage('--file is the PM plan document (JSON)');
    let plan: unknown;
    try {
      plan = JSON.parse(readFileSync(file, 'utf8'));
    } catch (e) {
      throw usage(`cannot read the plan ${file}: ${(e as Error).message}`);
    }
    const mode = flagStr(args, 'mode');
    if (mode !== null && mode !== 'stable' && mode !== 'fast') throw usage('--mode is stable or fast');
    let words = flagList(args, 'words');
    if (words.length === 0) words = [await messageOf(ctx, null)];
    const r = await flowAdapter().submitPlan(ctx, { mission, plan, userWords: words, changedItems: flagList(args, 'changed'), dependentItems: flagList(args, 'dependent'), mode: mode as 'stable' | 'fast' | null });
    return ok(r.text, r.json);
  },
};

const OPTIONS = DECISION_OPTIONS.filter((o) => o !== 'ask-user');

export const answerCmd: Command = {
  name: 'answer',
  summary: 'the user\'s answer to an escalation (3.8, WI-24): carried out like a Secretary decision',
  usage: `mp answer <mission> <escalation> --option ${OPTIONS.join('|')} --words "<the user's words>" [--instructions "<text>"] [--extra <n>]`,
  flags: { option: 'string', words: 'string', instructions: 'string', extra: 'string' },
  changesState: true,
  wi: 'WI-24',
  async run(ctx, args) {
    const option = flagStr(args, 'option');
    if (option === null || !OPTIONS.includes(option as Exclude<DecisionOption, 'ask-user'>)) throw usage(`--option is one of ${OPTIONS.join(', ')}`);
    const words = flagStr(args, 'words');
    if (words === null || words.trim() === '') throw usage('--words: the user\'s words (the PM never answers for the user)');
    const extra = flagStr(args, 'extra');
    const n = extra === null ? null : Number(extra);
    if (n !== null && (!Number.isSafeInteger(n) || n < 1)) throw usage('--extra is a positive integer');
    const r = await flowAdapter().answer(ctx, { mission: missionArg(args, 0), escalation: positional(args, 1, 'escalation'), option: option as DecisionOption, words, instructions: flagStr(args, 'instructions'), grantExtra: n });
    return ok(r.text, r.json);
  },
};

export const missionCmd: Command = {
  name: 'mission',
  summary: 'missions: open one, or list them',
  usage: 'mp mission open <mission> | mp mission list [--state open|closed|all]',
  flags: { state: 'string' },
  changesState: true,
  async run(ctx, args) {
    const sub = positional(args, 0, 'open or list');
    if (sub === 'list') {
      const st = flagStr(args, 'state') ?? 'open';
      if (st !== 'open' && st !== 'closed' && st !== 'all') throw usage('--state is open, closed or all');
      const r = await flowAdapter().listMissions(ctx, { state: st });
      return ok(r.text, r.json);
    }
    if (sub !== 'open') throw usage('mission takes open or list');
    const r = await flowAdapter().openMission(ctx, { mission: missionArg(args, 1) });
    return ok(r.text, r.json);
  },
};

export const legalizeCmd: Command = {
  name: 'legalize',
  summary: 'legalization the user asked for (11.1): compute the backfill plan, start it once the user agrees, or show its state',
  usage: 'mp legalize request <mission> <endpoint> --words "<the user\'s words>" [--id <legalization>] | mp legalize start <mission> <legalization> --words "<the user\'s words>" | mp legalize show <mission> <legalization>',
  flags: { words: 'string', id: 'string' },
  changesState: true,
  async run(ctx, args, op) {
    const sub = positional(args, 0, 'request, start or show');
    const mission = missionArg(args, 1);
    if (sub === 'show') {
      const r = await flowAdapter().legalizationState(ctx, { mission, legalization: positional(args, 2, 'legalization') });
      return ok(r.text, r.json);
    }
    const words = flagStr(args, 'words');
    if (words === null || words.trim() === '') throw usage('--words: the user\'s words asking for it (verbatim)');
    if (sub === 'request') {
      const endpoint = positional(args, 2, 'endpoint');
      // without --id the scheduler derives it from the request: the same request again is the same legalization
      const r = await flowAdapter().requestLegalization(ctx, { mission, legalization: flagStr(args, 'id'), endpoint, words });
      return ok(r.text, r.json, r.exitCode ?? 0);
    }
    if (sub === 'start') {
      const r = await flowAdapter().startLegalization(ctx, { mission, legalization: positional(args, 2, 'legalization'), words });
      return ok(r.text, r.json);
    }
    throw usage('legalize takes request, start or show');
  },
};
