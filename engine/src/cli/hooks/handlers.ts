// The PM session's Claude Code hooks (design 3.1, 3.9, 6.1, 6.3, 6.4, WI-12).
//
// SessionStart (6.3, when the engine starts): start the engine if it is not running, then put a
// short layer-0 summary, the WI-12 recovery-pause question or the risk-28 reminder,
// and the undelivered notices into the PM's context.
//
// UserPromptSubmit (3.1, 6.4): conservative stop detection first (wider rather than narrower: false
// positives are accepted, risk 9; misses are not) through the one stop entry
// (stopEntry: inboxes first, fast signal within 2 s, never the ledger service);
// then the user's words are booked (once per message id; spooled while the ledger
// cannot take them); then undelivered notices are added (3.9's fallback delivery).
//
// The hooks act only in a session whose working directory is inside a registered
// project (3.9: the hooks act only in the PM session, by a session marker). They never block or fail the
// prompt: any internal failure becomes a line in the context, and the exit is 0.

import { stopEntry, type StopRequest } from '../../ledger/stops.ts';
import { findConfigPath, loadCliConfig, projectOf, stopPathsOf, timeoutOf, type CliConfig } from '../config.ts';
import { Ctx, type CliIo } from '../context.ts';
import { errorMessage } from '../errors.ts';
import { listNotices, markDelivered, noticeLines, onceMark, syncNotices, type PmNotice } from '../notices.ts';
import { shortHash } from '../ops.ts';
import { DEFAULT_TAGGED_CAPABILITIES, describeScope, detectStop, stopScopeFor, stopWords } from '../stopDetect.ts';
import { bookUserWords, flushUserWords, messageIdFor } from '../userWords.ts';
import { pmCoreText, wiIndexText } from '../wi.ts';
import { RISK28_REMINDER_EN } from '../layer0.ts';
import { entryMessage, knownMissions } from '../commands/stops.ts';
import { ledgerPathsOf } from '../config.ts';

export type HookEvent = 'SessionStart' | 'UserPromptSubmit';

/** Claude Code's hook output: context for the model, and a message shown to the user. Never a block. */
export interface HookOutput {
  readonly hookSpecificOutput: { readonly hookEventName: HookEvent; readonly additionalContext: string };
  readonly systemMessage?: string;
}

export interface HookRun {
  /** null: not a PM session (no output at all). */
  readonly output: HookOutput | null;
  /** What happened, for tests and logs. */
  readonly facts: Record<string, unknown>;
}

const HEADER = '[Mission Pipeline 4]';

/** The configuration and project of a PM session, or null when this session is not one. */
export function pmSession(input: Record<string, unknown>, io: CliIo): { config: CliConfig; path: string } | null {
  const path = findConfigPath(null, io.env);
  if (path === null) return null;
  let config: CliConfig;
  try {
    config = loadCliConfig(path);
  } catch {
    return null;
  }
  const cwd = typeof input['cwd'] === 'string' && input['cwd'] !== '' ? input['cwd'] : io.cwd;
  if (io.env['MP_PM_SESSION'] !== '1' && projectOf(config, cwd) === null) return null;
  return { config, path };
}

async function deliverNotices(ctx: Ctx, max: number): Promise<{ lines: string[]; ids: string[] }> {
  let pending: PmNotice[];
  try {
    const src = { controlPlane: ctx.config.controlPlane, stateDir: ctx.config.stateDir, dbPath: ledgerPathsOf(ctx.config).db, content: ctx.content() };
    // the ledger's delivery states first: a notice shown or acknowledged in another session is not shown again
    await syncNotices(ctx.ledger(1_000), ctx.config.stateDir, listNotices(src).map((n) => n.id));
    pending = listNotices(src).filter((n) => n.state === 'undelivered');
  } catch {
    return { lines: [], ids: [] };
  }
  if (pending.length === 0) return { lines: [], ids: [] };
  const lines = [`Undelivered notices (${pending.length}; open the page of the WI each one names; all of them: mp alerts):`, ...noticeLines(pending, max)];
  try {
    markDelivered(ctx.config.stateDir, pending.map((n) => n.id), ctx.now);
  } catch {
    /* delivered again next time: a duplicate, never a loss */
  }
  await syncNotices(ctx.ledger(1_000), ctx.config.stateDir);
  return { lines, ids: pending.map((n) => n.id) };
}

// ---------------------------------------------------------------- SessionStart

export async function sessionStartHook(input: Record<string, unknown>, io: CliIo, o: { readonly startTimeoutMs?: number; readonly start?: boolean } = {}): Promise<HookRun> {
  const s = pmSession(input, io);
  if (s === null) return { output: null, facts: { pm: false } };
  const ctx = new Ctx(s.config, s.path, io);
  const lines: string[] = [];
  const facts: Record<string, unknown> = { pm: true, source: input['source'] ?? null };
  try {
    if (o.start !== false) {
      try {
        const { startEngine } = await import('../commands/engine.ts');
        const r = await startEngine(ctx, o.startTimeoutMs !== undefined ? { startTimeoutMs: o.startTimeoutMs } : {});
        facts['engine'] = r;
        if (r.started) lines.push('The engine was just started (it starts when the PM opens, 6.3).');
      } catch (e) {
        facts['engineError'] = errorMessage(e);
        lines.push(`The engine could not start: ${errorMessage(e)}. Stops still take effect through the inboxes and the fast notice; after reading the log per WI-22, mp ensure-running tries again.`);
      }
    }
    const { collectLayer0, renderLayer0 } = await import('../layer0.ts');
    const l0 = await collectLayer0(ctx, { ledgerTimeoutMs: 2_000 });
    facts['layer0'] = { recovery: l0.recovery, stops: l0.stops.length, notices: l0.notices };
    lines.push(renderLayer0(l0, { short: true }));
    const st = l0.recovery.startup;
    if (l0.recovery.paused) {
      const { wi12Question } = await import('../commands/recovery.ts');
      lines.push(
        `WI-12: after the restart the engine is in the recovery pause (no dispatch, no authorization). Ask the user now: "${wi12Question(st === null ? null : { at: st.at })}"`,
        'If the user says no: mp resume --answer "<the user\'s answer>"; if yes: mp resume --answer "<answer>" --stop-words "<what the user wants stopped>". While the user is away the pause stays; never answer for the user.',
        'Also check this session for stop or withdraw words after the last booked user message (mp recovery-check); submit any with mp stop first.',
      );
      facts['wi12'] = 'pause';
    } else if (st !== null && st.state === 'continued' && st.reminder !== null && onceMark(ctx.config.stateDir, `startup-reminder:${st.at}`, ctx.now)) {
      lines.push(`WI-12 (risk 28, option A): the engine went on by itself after the restart. Also remind the user: "${RISK28_REMINDER_EN}"`);
      facts['wi12'] = 'reminder';
    }
    const n = await deliverNotices(ctx, 10);
    lines.push(...n.lines);
    facts['delivered'] = n.ids;
    // The handbook's index only (maintainer ruling 2026-10-09): pages are opened when a notice names a WI.
    lines.push('', pmCoreText(io.env), '', wiIndexText(io.env));
    if (ctx.config.engineRoot !== null) lines.push(`CLI: mp (${ctx.config.engineRoot.replace(/\/$/, '')}/plugin/bin/mp; mp help lists all commands)`);
  } catch (e) {
    lines.push(`(error while reading the state: ${errorMessage(e)}; mp status reads it again)`);
    facts['error'] = errorMessage(e);
  } finally {
    ctx.close();
  }
  return { output: { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: `${HEADER}\n${lines.join('\n')}` } }, facts };
}

// ---------------------------------------------------------------- UserPromptSubmit

export async function userPromptSubmitHook(input: Record<string, unknown>, io: CliIo): Promise<HookRun> {
  const s = pmSession(input, io);
  if (s === null) return { output: null, facts: { pm: false } };
  const ctx = new Ctx(s.config, s.path, io);
  const prompt = typeof input['prompt'] === 'string' ? input['prompt'] : '';
  const session = typeof input['session_id'] === 'string' ? input['session_id'] : 'unknown';
  const message = messageIdFor(input);
  const lines: string[] = [];
  const facts: Record<string, unknown> = { pm: true, message };
  let systemMessage: string | undefined;
  try {
    // 1. Stops first: the user's safety floor never waits for anything else.
    const d = detectStop(prompt);
    facts['detection'] = d;
    if (d.detected) {
      let req: StopRequest | null = null;
      try {
        const missions = await knownMissions(ctx, 1_000);
        const decided = stopScopeFor(prompt, d, { knownMissions: missions.known, openMissions: missions.open, complete: missions.complete, tagged: ctx.config.taggedCapabilities ?? DEFAULT_TAGGED_CAPABILITIES });
        req = { stop: `stop-${shortHash(message, 20)}` as StopRequest['stop'], scope: decided.scope, words: stopWords(prompt), at: ctx.now };
        const r = stopEntry(stopPathsOf(ctx.config), req);
        const said = entryMessage(r);
        facts['stop'] = { stop: req.stop, scope: req.scope, result: r.result, exitCode: r.exitCode, message: said };
        systemMessage = `Stop: ${said}`;
        lines.push(
          `The user's words contain stop, forbid or withdraw phrasing (${d.triggers.join(', ')}); the program stopped at once at a conservative scope (6.4: wider rather than narrower):`,
          said,
          `Stop id: ${req.stop}; scope: ${describeScope(req.scope)} (${decided.why})`,
          'A stop in error (risk 9): after confirming with the user, mp stop-narrow <stop id> --scope ... narrows it, or mp stop-release <stop id> releases it; cancelled work does not come back by itself.',
        );
        if (r.notice !== null) lines.push('WI-12: this stop could not be persisted (its fast notice was sent); tell the user to say it again if they still want it.');
      } catch (e) {
        facts['stopError'] = errorMessage(e);
        systemMessage = `The stop could not be sent: ${errorMessage(e)}`;
        lines.push(`Stop words were found, but the stop entry failed: ${errorMessage(e)}. Run in the terminal now: mp stop "${prompt.slice(0, 200).replace(/"/g, '\\"')}"`);
      }
    }
    // 2. The user's words, once per message id (3.1, 10.1 item 6).
    const client = ctx.ledger(timeoutOf(ctx.config, 'hookLedgerMs'));
    try {
      const b = await bookUserWords(client, ctx.config.stateDir, { message, session, at: ctx.now, text: prompt });
      facts['words'] = b;
      if (b.booked) {
        const f = await flushUserWords(client, ctx.config.stateDir, 20);
        if (f.booked > 0) facts['flushed'] = f.booked;
      } else if (!b.spooled) lines.push(`(this message could not be booked in the ledger: ${b.reason})`);
    } finally {
      client.close();
    }
    // 3. Notices not delivered yet (3.9: the fallback when the monitor did not wake the PM).
    const n = await deliverNotices(ctx, 5);
    lines.push(...n.lines);
    facts['delivered'] = n.ids;
  } catch (e) {
    facts['error'] = errorMessage(e);
  } finally {
    ctx.close();
  }
  if (lines.length === 0) return { output: null, facts };
  return { output: { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: `${HEADER}\n${lines.join('\n')}` }, ...(systemMessage !== undefined ? { systemMessage } : {}) }, facts };
}
