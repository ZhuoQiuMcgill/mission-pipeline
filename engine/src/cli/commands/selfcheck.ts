// `mp selfcheck` (design 9.3, WI-18): the startup self-check, offline and live, recorded for the
// versions in use (src/seat/selfcheckLive.ts). Seats start once it passes. `mp install` runs it,
// and the engine start path runs it by itself (`--auto`, detached) after an update changed the
// versions; this command is also the manual retry WI-18 names.

import { execAlert, DeliveringAlertSink } from '../../exec/alerts.ts';
import { flagBool, type ParsedArgs } from '../args.ts';
import type { Command, CommandResult } from '../command.ts';
import { ok } from '../command.ts';
import type { Ctx } from '../context.ts';
import { CliError, EXIT } from '../errors.ts';
import type { SelfCheckResult } from '../../exec/selfcheck.ts';
import type { SelfCheckFailure, SelfCheckRun } from '../../seat/selfcheckLive.ts';

/** One line per item, failures first. */
export function selfCheckLines(results: readonly SelfCheckResult[]): string[] {
  const sorted = [...results].sort((a, b) => Number(a.ok) - Number(b.ok) || a.item - b.item);
  return sorted.map((r) => `  item ${r.item} (${r.mode}): ${r.ok ? 'ok' : `FAILED: ${r.detail.slice(0, 300)}`}`);
}

/** One WI-18 notice per version key naming the failing items (the same key raised again is the same notice). */
export async function raiseSelfCheckFailure(stateDir: string, ledger: ConstructorParameters<typeof DeliveringAlertSink>[2], f: SelfCheckFailure, auto: boolean): Promise<void> {
  const sink = new DeliveringAlertSink(stateDir, 'selfcheck', ledger);
  await sink.alert(
    execAlert(
      'selfcheck-failed',
      null,
      `the startup self-check did not pass for these versions (key ${f.key}): ${f.failing.join('; ')}`,
      { versions: f.versions, key: f.key, failing: f.failing, automatic: auto },
      'no seat starts for these versions; work that needs no seat goes on; the self-check runs again by itself at most once an hour per version (or now: mp selfcheck)',
      `selfcheck-run:${f.key}`,
    ),
  );
  await sink.flush(5_000);
}

export const selfCheckCmd: Command = {
  name: 'selfcheck',
  summary: 'runs the startup self-check (offline items, live items 1-3 under the seat login, item 8) for the versions in use; seats start once it passes (WI-18)',
  usage: 'mp selfcheck [--auto]',
  flags: { auto: 'boolean' },
  changesState: false,
  wi: 'WI-18',
  async run(ctx: Ctx, args: ParsedArgs): Promise<CommandResult> {
    const auto = flagBool(args, 'auto');
    const { failureOf, recordAttempt, runLevelFailure, runStartupSelfCheck, selfCheckSetupFromEngineConfig } = await import('../../seat/selfcheckLive.ts');
    const setup = selfCheckSetupFromEngineConfig(ctx.config.engineConfig);
    if ('unavailable' in setup) throw new CliError('NO_SEAT_INSTALLATION', `the self-check cannot run: ${setup.unavailable}`, { exitCode: EXIT.REFUSED, wi: 'WI-18' });
    // any failure, including one that stops the run itself, is a WI-18 notice and a non-zero exit (r6)
    let run: SelfCheckRun | null = null;
    let failure: SelfCheckFailure | null = null;
    // r7: the run is "running" before it starts: a run that crashes, or whose evidence cannot be
    // written, still denies seats through its attempt (the gate reads the latest one)
    const startKey = runLevelFailure(new Error('-'), setup.claudeExecutable).key;
    try {
      if (startKey !== 'unknown-versions') recordAttempt(setup.dir, startKey, 'running');
    } catch {
      /* nothing can be written: the run goes on; a failure still exits non-zero with WI-18 */
    }
    try {
      const { pmMonitorProbe } = await import('../pmMonitorProbe.ts');
      run = await runStartupSelfCheck(setup, { pmProbe: pmMonitorProbe({ configPath: ctx.configPath }) });
      if (!run.gate.seatsAllowed) failure = failureOf(run);
    } catch (e) {
      failure = runLevelFailure(e, setup.claudeExecutable);
    }
    const key = run?.key ?? failure?.key ?? null;
    try {
      if (key !== null && key !== 'unknown-versions') recordAttempt(setup.dir, key, failure === null ? 'passed' : 'failed');
    } catch {
      /* the attempt record only paces the automatic runs */
    }
    if (failure !== null) {
      let ledger: ConstructorParameters<typeof DeliveringAlertSink>[2] = null;
      try {
        ledger = { client: ctx.ledger(5_000), content: ctx.content() };
      } catch {
        ledger = null; // the local copy is kept; the scheduler carries it over
      }
      await raiseSelfCheckFailure(ctx.config.stateDir, ledger, failure, auto);
    }
    const head =
      failure === null
        ? `The startup self-check passed for these versions (key ${key}): seats can start.`
        : `The startup self-check did not pass for these versions (key ${failure.key}); no seat starts until it does (WI-18): ${run?.gate.reason ?? failure.failing.join('; ')}`;
    const text = [head, ...(run !== null ? selfCheckLines(run.results) : [])].join('\n');
    return ok(
      text,
      { passed: failure === null, key, versions: run?.versions ?? failure?.versions ?? null, gate: run?.gate ?? null, failing: failure?.failing ?? [], results: (run?.results ?? []).map((r) => ({ item: r.item, mode: r.mode, ok: r.ok, detail: r.detail })) },
      failure === null ? 0 : EXIT.REFUSED,
    );
  },
};
