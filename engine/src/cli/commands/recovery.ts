// The recovery pause after a reboot (design 6.1, startup handling; WI-12).
//
// `mp resume` is the PM's WI-12 action, only after the user answered the question ("stops
// sent after <start> without a 'persisted' confirmation may not have been recorded; did you
// ask to stop or withdraw anything then?"). "No" → resume. "Yes" → the stop the user names
// is submitted first (`--stop-words`), committed, and only then is the rest resumed. An
// answer that itself sounds like a stop is never taken as "no" silently: the PM says which
// it is (`--stop-words` or `--no-stop`). The PM never answers for the user. The user's
// answer is recorded with the cleared pause (confirmResume { op, answer }).

import type { StartupDecision } from '../../ledger/queries.ts';
import { readStopHistory, stopEntry, type StopRequest } from '../../ledger/stops.ts';
import { flagBool, flagStr, type ParsedArgs } from '../args.ts';
import type { Command } from '../command.ts';
import { ok } from '../command.ts';
import { ledgerPathsOf, stopPathsOf } from '../config.ts';
import type { Ctx } from '../context.ts';
import { CliError, EXIT, usage } from '../errors.ts';
import { subOp } from '../ops.ts';
import { describeScope, detectStop, parseScope, stopWords } from '../stopDetect.ts';
import { RISK28_REMINDER_EN } from '../layer0.ts';
import { conservativeScope, entryMessage, stopIdForOp } from './stops.ts';

interface LedgerStatus {
  readonly recoveryPause: boolean;
  readonly recoveryPausedSince: number | null;
  readonly startup: StartupDecision | null;
}

const when = (ms: number): string => new Date(ms).toISOString().replace('T', ' ').slice(0, 19) + ' UTC';

/** The WI-12 question, with the restart time (6.1). */
export function wi12Question(startup: Pick<StartupDecision, 'at'> | null): string {
  const t = startup === null ? 'recently' : `around ${when(startup.at)}`;
  return `The machine restarted ${t}; stops sent before the restart without a 'persisted' confirmation may not have been recorded. During that time, did you ask to stop or withdraw anything in the PM session or the terminal?`;
}

export const resumeCmd: Command = {
  name: 'resume',
  summary: 'WI-12: after the user answered, confirm going on (when they say yes, their stop is submitted first)',
  usage: 'mp resume --answer "<the user\'s answer>" [--stop-words "<what the user wants stopped>" [--scope ...]] [--no-stop]',
  flags: { answer: 'string', 'stop-words': 'string', scope: 'string', 'no-stop': 'boolean' },
  changesState: true,
  wi: 'WI-12',
  async run(ctx: Ctx, args: ParsedArgs, op) {
    const answer = (flagStr(args, 'answer') ?? '').trim();
    if (answer === '') throw usage('resume only after the user answered: --answer "<the user\'s answer>" (the PM never answers for the user)');
    const stopWordsFlag = flagStr(args, 'stop-words');
    const noStop = flagBool(args, 'no-stop');
    if (stopWordsFlag !== null && noStop) throw usage('--stop-words and --no-stop cannot both be given');
    const st = (await ctx.call('status', {})) as LedgerStatus;
    if (!st.recoveryPause) {
      return ok('There is no recovery pause now; nothing to confirm (it may have been confirmed already).', { paused: false, startup: st.startup, answer });
    }
    const d = detectStop(answer);
    if (d.detected && stopWordsFlag === null && !noStop) {
      throw new CliError(
        'ANSWER_UNCLEAR',
        `the user's answer contains stop or withdraw words (${d.triggers.join(', ')}). If the user did ask to stop: --stop-words "<what to stop>" submits it first, then goes on; if the user meant "no": add --no-stop.`,
        { exitCode: EXIT.REFUSED, wi: 'WI-12' },
      );
    }
    let submitted: { stop: string; scope: string; message: string } | null = null;
    if (stopWordsFlag !== null) {
      const scopeFlag = flagStr(args, 'scope');
      const scope = scopeFlag !== null ? parseScope(scopeFlag) : (await conservativeScope(ctx, stopWordsFlag)).scope;
      if (scope === null) throw usage(`--scope is malformed: ${scopeFlag}`);
      const req: StopRequest = { stop: stopIdForOp(subOp(op!, 'wi12-stop')), scope, words: stopWords(stopWordsFlag), at: ctx.now };
      const entry = stopEntry(stopPathsOf(ctx.config), req);
      // committed before anything resumes (the stop is the safety floor, 3.11 principle 4)
      await ctx.call('stop', req);
      const state = (await ctx.call('stopState', { stop: req.stop })) as string | null;
      if (state !== 'active') throw new CliError('NOT_COMMITTED', `the stop ${req.stop} was not committed; not going on`, { exitCode: EXIT.FAILED, wi: 'WI-12' });
      submitted = { stop: req.stop, scope: describeScope(scope), message: entryMessage(entry) };
    }
    // The scheduler first (it also lifts its own pause at once); else the ledger, which the scheduler reads.
    let via: 'scheduler' | 'ledger' = 'scheduler';
    try {
      await ctx.sched('confirmResume', { op, answer });
    } catch (e) {
      if (!(e instanceof CliError) || e.code !== 'UNAVAILABLE') throw e;
      via = 'ledger';
      await ctx.call('confirmResume', { op: op!, answer });
    }
    const lines = [`Going on, confirmed per WI-12 (through the ${via === 'scheduler' ? 'scheduler' : 'ledger service'}); the user's answer, recorded with it: ${answer}`];
    if (submitted !== null) lines.unshift(`First submitted the stop ${submitted.stop} (${submitted.scope}): ${submitted.message} Committed.`);
    return ok(lines.join('\n'), { resumed: true, via, answer, submittedStop: submitted });
  },
};

export const recoveryCheckCmd: Command = {
  name: 'recovery-check',
  summary: 'WI-12 material: the startup decision and its basis, stops in the inboxes, the last booked user message, external actions with undetermined outcomes',
  usage: 'mp recovery-check',
  flags: {},
  changesState: false,
  async run(ctx) {
    let check: Record<string, unknown>;
    let via = 'scheduler';
    try {
      check = (await ctx.sched('recoveryCheck', {})) as Record<string, unknown>;
    } catch (e) {
      if (!(e instanceof CliError) || e.code !== 'UNAVAILABLE') throw e;
      via = 'ledger';
      const lp = ledgerPathsOf(ctx.config);
      const requested = readStopHistory({ inbox: lp.inbox, controlPlane: ctx.config.controlPlane, ...(ctx.config.backupInbox !== undefined ? { backupInbox: ctx.config.backupInbox } : {}) });
      const st = (await ctx.call('status', {})) as LedgerStatus;
      const committed = (await ctx.call('activeStops', {})) as Array<{ stop: string; words: string; committedAt: number }>;
      const words = (await ctx.call('latestUserWords', { limit: 1 })) as Array<{ revision: number; message: string; session: string; at: number; excerpt: string }>;
      const intents = (await ctx.call('openIntents', {})) as Array<{ intent: string; kind: string; domain: string; state: string; tag: { mission: string } }>;
      const uncommitted: string[] = [];
      for (const r of requested) if ((await ctx.call('stopState', { stop: r.stop })) === null) uncommitted.push(r.stop);
      check = {
        format: 'mp4.recovery-check.v3',
        paused: st.recoveryPause,
        startup: st.startup,
        inboxStops: requested.map((r) => ({ stop: r.stop, words: r.words, at: r.at, committed: !uncommitted.includes(r.stop) })),
        committedStops: committed.map((s) => ({ stop: s.stop, words: s.words, committedAt: s.committedAt })),
        lastUserWords: words[0] ?? null,
        pendingIntents: intents.map((i) => ({ intent: i.intent, kind: i.kind, domain: i.domain, state: i.state, mission: i.tag.mission })),
        uncommittedStops: uncommitted,
      };
    }
    const startup = (check['startup'] ?? null) as StartupDecision | null;
    const last = check['lastUserWords'] as { at: number; excerpt: string } | null;
    const lines = [
      `Recovery pause: ${check['paused'] ? 'yes (WI-12: ask the user first)' : 'no'}`,
      `Startup decision: ${startup === null ? 'none' : `${startup.state === 'set' ? 'recovery pause' : 'went on'} (evidence: ${startup.basis.evidence}; ${when(startup.at)})`}`,
      `Stops in the inboxes and the staging copy: ${(check['inboxStops'] as unknown[]).length}, not committed ${(check['uncommittedStops'] as unknown[]).length}`,
      `Last booked user message: ${last === null ? 'none' : `${when(last.at)} "${last.excerpt}"`} (only for submitting a missing stop, never for deciding whether to go on)`,
      `External actions started before a stop, outcome undetermined: ${(check['pendingIntents'] as unknown[]).length}`,
    ];
    if (check['paused']) lines.push(`Ask the user: ${wi12Question(startup)}`);
    if (startup?.basis.reminder) lines.push(`Risk 28 reminder for the user: ${RISK28_REMINDER_EN}`);
    return ok(lines.join('\n'), { via, ...check });
  },
};
