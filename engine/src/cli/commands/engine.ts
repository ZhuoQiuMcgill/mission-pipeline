// Engine commands (design 6.3, when the engine starts): the engine starts when the user opens
// the PM (the session-start hook calls the same function), never at boot.

import { readFileSync } from 'node:fs';
import { engineState, ensureRunning, type EngineConfig } from '../../scheduler/engine.ts';
import type { Command } from '../command.ts';
import { ok } from '../command.ts';
import type { Ctx } from '../context.ts';
import { CliError, EXIT, errorMessage } from '../errors.ts';
import { flushUserWords } from '../userWords.ts';
import { flushInstallStates } from './install.ts';

export function readEngineConfig(ctx: Ctx): EngineConfig {
  const p = ctx.config.engineConfig;
  if (p === null) throw new CliError('NO_CONFIG', 'no engine start configuration (engineConfig): run mp install first', { exitCode: EXIT.NO_CONFIG });
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as EngineConfig;
  } catch (e) {
    throw new CliError('NO_CONFIG', `cannot read the engine start configuration ${p}: ${errorMessage(e)}`, { exitCode: EXIT.NO_CONFIG });
  }
}

/** Start the engine if it is not running, then book user words that waited for the ledger. */
export async function startEngine(
  ctx: Ctx,
  o: { readonly startTimeoutMs?: number } = {},
): Promise<{ started: boolean; running: boolean; watchdogPid: number | null; ledgerBeating: boolean; schedulerBeating: boolean; booked: number; selfCheck: { started: boolean; why: string; key: string | null } }> {
  const cfg = readEngineConfig(ctx);
  const r = await ensureRunning(o.startTimeoutMs !== undefined ? { ...cfg, startTimeoutMs: o.startTimeoutMs } : cfg);
  let booked = 0;
  try {
    booked = (await flushUserWords(ctx.ledger(), ctx.config.stateDir)).booked;
    await flushInstallStates(ctx.ledger(), ctx.content(), ctx.config.stateDir);
  } catch {
    /* they wait for the next start */
  }
  // 9.3: after an update changed the versions (or before any live run), the self-check runs by
  // itself in the background (detached, at most once per version key per hour); seats wait for it
  let selfCheck: { started: boolean; why: string; key: string | null } = { started: false, why: 'not checked', key: null };
  try {
    const { maybeStartBackgroundSelfCheck } = await import('../../seat/selfcheckLive.ts');
    selfCheck = maybeStartBackgroundSelfCheck({ configPath: ctx.configPath, engineConfig: ctx.config.engineConfig, stateDir: ctx.config.stateDir });
  } catch {
    /* the next start tries again */
  }
  return { ...r, booked, selfCheck };
}

export const ensureRunningCmd: Command = {
  name: 'ensure-running',
  summary: 'starts the engine if it is not running (watchdog -> ledger service and scheduler); does nothing if it is',
  usage: 'mp ensure-running',
  flags: {},
  changesState: false,
  async run(ctx) {
    try {
      const r = await startEngine(ctx);
      const text = `${r.started ? 'Engine started' : 'The engine is already running'} (watchdog pid ${r.watchdogPid ?? '?'}; ledger service ${r.ledgerBeating ? 'beating' : 'not beating'}, scheduler ${r.schedulerBeating ? 'beating' : 'not beating'})${r.booked > 0 ? `; booked ${r.booked} user messages that were waiting for the ledger` : ''}`;
      return ok(text, r);
    } catch (e) {
      if (e instanceof CliError) throw e;
      throw new CliError('ENGINE_START_FAILED', `the engine could not start: ${errorMessage(e)}. Stops can still be sent through the inboxes and the fast notice (mp stop); see the watchdog log per WI-22`, { exitCode: EXIT.UNAVAILABLE, wi: 'WI-22' });
    }
  },
};

export const engineStateCmd: Command = {
  name: 'engine-state',
  summary: 'whether the watchdog, the ledger service and the scheduler are running',
  usage: 'mp engine-state',
  flags: {},
  changesState: false,
  async run(ctx) {
    const s = engineState(readEngineConfig(ctx));
    const text = `Watchdog: ${s.running ? `running (pid ${s.watchdogPid})` : 'not running'}; ledger service: ${s.ledgerBeating ? 'beating' : 'not beating'}; scheduler: ${s.schedulerBeating ? 'beating' : 'not beating'}`;
    return ok(text, s);
  },
};
