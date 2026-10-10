// Stops (design 6.1, delivery of stop requests; 6.4). `mp stop` is one of the two stop
// entries (the other is the PM's prompt hook): both call stopEntry, which never talks to
// the ledger service, writes both inboxes, and raises the fast signal within 2 seconds. The
// command prints the entry's message and exits with its code (0 persisted, 75 notified but
// not persisted, 76 neither).
//
// Narrowing (6.4) rewrites a stop as a narrower structured scope through the ledger's
// narrowStop: the narrower stop is committed and the old one released in one transaction,
// linked both ways, so nothing in the narrower scope is unrestricted at any moment.

import { id, missionIdProblem, type StopId } from '../../common/ids.ts';
import type { ActiveStop } from '../../ledger/queries.ts';
import { stopEntry, type StopEntryReport, type StopRequest, type StopScope } from '../../ledger/stops.ts';
import { flagStr, positional, type ParsedArgs } from '../args.ts';
import type { Command, CommandResult } from '../command.ts';
import { ok } from '../command.ts';
import { stopPathsOf } from '../config.ts';
import type { Ctx } from '../context.ts';
import { CliError, EXIT, usage } from '../errors.ts';
import { shortHash } from '../ops.ts';
import { DEFAULT_TAGGED_CAPABILITIES, describeScope, detectStop, parseScope, scopeWithin, stopScopeFor, stopWords } from '../stopDetect.ts';

export function stopIdForOp(op: string): StopId {
  return id<StopId>(`stop-${shortHash(op, 20)}`);
}

/**
 * The missions the ledger knows now: the open ones, and those with queued, running or blocked
 * work. `complete` is true only when every query answered in time; a stop narrows only then
 * (review r1: a missing answer could hide the other mission, so doubt means everything).
 */
export async function knownMissions(ctx: Ctx, timeoutMs: number): Promise<{ known: string[]; open: string[]; complete: boolean }> {
  const client = ctx.ledger(timeoutMs);
  let complete = true;
  // each query on its own: one that fails or times out does not hide what the others know, but the answer is incomplete
  const q = <T>(method: 'missions' | 'taskQueue' | 'launches', params: object): Promise<T[]> =>
    (client.call(method, params as never) as Promise<T[]>).then(
      (v) => (Array.isArray(v) ? v : ((complete = false), [] as T[])),
      () => ((complete = false), [] as T[]),
    );
  try {
    const [m, queued, running] = await Promise.all([
      q<{ mission: string }>('missions', { state: 'open' }),
      q<{ mission: string }>('taskQueue', {}),
      q<{ tag: { mission: string } }>('launches', { unfinished: true }),
    ]);
    const known = new Set<string>([...m.map((x) => x.mission), ...queued.map((x) => x.mission), ...running.map((x) => x.tag.mission)]);
    // "the related mission" (6.4): the open missions, and those with work queued or running
    return { known: [...known], open: [...known], complete };
  } finally {
    client.close();
  }
}

/** The stop entry's exact message (the ledger's wording), or an English one if an older ledger answered in Chinese. */
export function entryMessage(r: StopEntryReport): string {
  if (!/[\u4e00-\u9fff]/.test(r.message)) return r.message;
  const base =
    r.result === 'persisted'
      ? 'Fast notice sent; persisted (awaiting commit).'
      : r.result === 'notified-not-persisted'
        ? 'Fast notice sent, but it could not be persisted (awaiting commit).'
        : r.result === 'persisted-not-notified'
          ? 'Persisted (awaiting commit), but the fast notice could not be sent.'
          : 'The fast notice could not be sent and the stop could not be persisted; the inbox writes are still being retried in the background.';
  return Object.values(r.inboxes).includes('exhausted') ? `${base} This boot's inbox slots are used up (WI-12).` : base;
}

export function renderEntry(r: StopEntryReport, req: StopRequest, why: string | null): string {
  const lines = [entryMessage(r), `Stop id: ${req.stop}; scope: ${describeScope(req.scope)}${why !== null ? ` (${why})` : ''}`];
  if (r.notice !== null) lines.push('WI-12: tell the user this stop sent its fast notice but could not be persisted; the inbox writes go on in the background. Ask them to say it again if they still want it.');
  return lines.join('\n');
}

function entryJson(r: StopEntryReport, req: StopRequest, why: string | null): unknown {
  return { stop: req.stop, scope: req.scope, words: req.words, why, result: r.result, message: entryMessage(r), exitCode: r.exitCode, durable: r.durable, spooled: r.spooled, inboxes: r.inboxes, notice: r.notice === null ? null : entryMessage(r), writerPids: r.writerPids };
}

/** The conservative scope of a stop from the user's words (6.4: wider rather than narrower). */
export async function conservativeScope(ctx: Ctx, words: string, timeoutMs = 1_000): Promise<{ scope: StopScope; why: string }> {
  const m = await knownMissions(ctx, timeoutMs);
  return stopScopeFor(words, { ...detectStop(words), detected: true }, { knownMissions: m.known, openMissions: m.open, complete: m.complete, tagged: ctx.config.taggedCapabilities ?? DEFAULT_TAGGED_CAPABILITIES });
}

export const stopCmd: Command = {
  name: 'stop',
  summary: 'send a stop (the same entry as the prompt hook): writes both inboxes, fast notice within 2 s',
  usage: 'mp stop "<the user\'s words>" [--scope all|mission:<id>|capability:<name>]',
  flags: { scope: 'string' },
  changesState: true,
  async run(ctx, args, op) {
    const words = positional(args, 0, "the user's words");
    const scopeFlag = flagStr(args, 'scope');
    let scope: StopScope;
    let why: string | null;
    if (scopeFlag !== null) {
      const s = parseScope(scopeFlag);
      if (s === null) throw usage(`--scope is all, mission:<id> or capability:<name>, not ${scopeFlag}`);
      const bad = s.kind === 'mission' ? missionIdProblem(s.mission) : null;
      // a stop is never refused: a mission id no mission can have widens it to everything
      scope = bad === null ? s : { kind: 'all' };
      why = bad === null ? 'as --scope says' : `--scope names no possible mission (${bad}): restricts everything`;
    } else {
      const d = await conservativeScope(ctx, words);
      scope = d.scope;
      why = d.why;
    }
    const req: StopRequest = { stop: stopIdForOp(op!), scope, words: stopWords(words), at: ctx.now };
    const r = stopEntry(stopPathsOf(ctx.config), req);
    return ok(renderEntry(r, req, why), entryJson(r, req, why), r.exitCode);
  },
};

async function activeStop(ctx: Ctx, stop: string): Promise<ActiveStop | null> {
  const all = (await ctx.call('activeStops', {})) as ActiveStop[];
  return all.find((s) => s.stop === stop) ?? null;
}

export const stopNarrowCmd: Command = {
  name: 'stop-narrow',
  summary: 'after confirming with the user, rewrite a stop as a narrower structured scope (one ledger transaction)',
  usage: 'mp stop-narrow <stop id> --scope mission:<id>|capability:<name>',
  flags: { scope: 'string' },
  changesState: true,
  async run(ctx, args, op): Promise<CommandResult> {
    const old = positional(args, 0, 'stop id');
    const scopeFlag = flagStr(args, 'scope');
    if (scopeFlag === null) throw usage('stop-narrow needs --scope');
    const scope = parseScope(scopeFlag);
    if (scope === null) throw usage(`--scope is all, mission:<id> or capability:<name>, not ${scopeFlag}`);
    const bad = scope.kind === 'mission' ? missionIdProblem(scope.mission) : null;
    if (bad !== null) throw usage(bad);
    const newId = stopIdForOp(op!);
    const prev = await activeStop(ctx, old);
    if (prev === null) {
      // a retry after it committed: the ledger answers with the same links
      if ((await ctx.call('stopState', { stop: newId })) === 'active') return ok(`Stop ${old} was narrowed to ${newId} (${describeScope(scope)}).`, { old, stop: newId, scope, narrowed: false, replayed: true });
      throw new CliError('NOT_ACTIVE', `stop ${old} is not an active stop (not committed, or already released)`, { exitCode: EXIT.REFUSED });
    }
    if (!scopeWithin(scope, prev.scope)) throw new CliError('NOT_NARROWER', `the new scope (${describeScope(scope)}) is not inside the old one (${describeScope(prev.scope)}): narrowing only shrinks a scope; for another scope send a new stop, then release the old one`, { exitCode: EXIT.REFUSED });
    if (JSON.stringify(scope) === JSON.stringify(prev.scope)) throw new CliError('SAME_SCOPE', `the new scope is the old one (${describeScope(scope)})`, { exitCode: EXIT.REFUSED });
    const req: StopRequest = { stop: newId, scope, words: stopWords(`${prev.words} (narrowed from ${prev.stop} after the PM confirmed with the user)`), at: ctx.now };
    const r = (await ctx.call('narrowStop', { old: id<StopId>(old), stop: req })) as { old: string; stop: string; narrowed: boolean };
    return ok(`Stop ${old} (${describeScope(prev.scope)}) narrowed to ${r.stop} (${describeScope(scope)}): the new one committed and the old one released in one step.`, { old, stop: r.stop, scope, previousScope: prev.scope, narrowed: r.narrowed });
  },
};

export const stopReleaseCmd: Command = {
  name: 'stop-release',
  summary: 'release a stop (a stop in error can be released at once; cancelled work does not come back by itself)',
  usage: 'mp stop-release <stop id> [--reason "<why>"]',
  flags: { reason: 'string' },
  changesState: true,
  identity: (a: ParsedArgs) => ({ stop: a.positionals[0] ?? null }),
  async run(ctx, args) {
    const stop = positional(args, 0, 'stop id');
    const rel = (await ctx.call('releaseStop', { stop })) as { released: boolean };
    if (!rel.released) {
      const st = (await ctx.call('stopState', { stop })) as string | null;
      if (st === null) throw new CliError('NOT_COMMITTED', `stop ${stop} is not committed yet and cannot be released (release it once committed; a stop still in an inbox is committed first)`, { exitCode: EXIT.REFUSED });
      return ok(`Stop ${stop} was already released.`, { stop, released: false, state: st });
    }
    return ok(`Stop ${stop} released. Work it cancelled does not come back by itself: plan it again if needed.`, { stop, released: true, reason: flagStr(args, 'reason') });
  },
};
