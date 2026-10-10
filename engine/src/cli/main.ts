// `mp`: the PM's CLI (design 9.2). Human-readable Chinese text by default, `--json`
// for machines. Every state-changing command carries an operation id (`--op`, or a
// generated one, printed) and is recorded in the operation journal, so a retry with
// the same id is idempotent (ops.ts).
//
//   node --experimental-strip-types src/cli/main.ts <command> [args] [--json] [--config <file>] [--op <id>]

import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { GLOBAL_FLAGS, flagBool, flagStr, parseArgs, type ParsedArgs } from './args.ts';
import type { Command, CommandResult } from './command.ts';
import { resolve } from 'node:path';
import { defaultConfigPath, findConfigPath, loadCliConfig, parseCliConfig, CLI_CONFIG_FORMAT, type CliConfig } from './config.ts';
import { Ctx, type CliIo } from './context.ts';
import { CliError, EXIT, errorMessage } from './errors.ts';
import { checkOpId, newOpId } from './ops.ts';
import { engineStateCmd, ensureRunningCmd } from './commands/engine.ts';
import { alertsCmd, opsCmd, showCmd, statusCmd } from './commands/read.ts';
import { stopCmd, stopNarrowCmd, stopReleaseCmd } from './commands/stops.ts';
import { recoveryCheckCmd, resumeCmd } from './commands/recovery.ts';
import { grantCmd, modelConfigCmd, retryEvaluatorCmd, retryServiceCmd, spendLimitCmd } from './commands/wi.ts';
import { closeCmd, deliverCmd, detachDuplicateCmd, landCmd, withdrawDeliveryCmd } from './commands/delivery.ts';
import { installCmd } from './commands/install.ts';
import { selfCheckCmd } from './commands/selfcheck.ts';
import { watchNoticesCmd } from './commands/watch.ts';
import { answerCmd, constraintCmd, legalizeCmd, missionCmd, planCmd, requirementCmd } from './commands/flow.ts';

export const COMMANDS: readonly Command[] = [
  ensureRunningCmd,
  engineStateCmd,
  statusCmd,
  showCmd,
  alertsCmd,
  watchNoticesCmd,
  stopCmd,
  stopNarrowCmd,
  stopReleaseCmd,
  resumeCmd,
  recoveryCheckCmd,
  deliverCmd,
  landCmd,
  withdrawDeliveryCmd,
  detachDuplicateCmd,
  closeCmd,
  retryEvaluatorCmd,
  retryServiceCmd,
  grantCmd,
  spendLimitCmd,
  modelConfigCmd,
  requirementCmd,
  constraintCmd,
  planCmd,
  answerCmd,
  missionCmd,
  legalizeCmd,
  installCmd,
  selfCheckCmd,
  opsCmd,
];

export interface CliOutput {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

function help(): string {
  const w = Math.max(...COMMANDS.map((c) => c.name.length));
  return ['mp: the PM command group of Mission Pipeline 4', '', ...COMMANDS.map((c) => `  ${c.name.padEnd(w)}  ${c.summary}`), '', 'Global options: --json (machine-readable output), --config <file>, --op <operation id> (state-changing commands can be retried)', 'Usage of each command: mp <command> --help'].join('\n');
}

function render(r: CommandResult, json: boolean, op: string | null, replay: boolean): string {
  if (json) return `${JSON.stringify({ ok: r.exitCode === 0, exitCode: r.exitCode, ...(op !== null ? { op, replayed: replay } : {}), result: r.json })}\n`;
  const head = op !== null ? `Operation id: ${op}${replay ? ' (replay: this operation already completed; its original result follows, nothing was run again)' : ''}\n` : '';
  return `${head}${r.text}\n`;
}

function renderError(e: CliError, json: boolean, op: string | null): string {
  if (json) return `${JSON.stringify({ ok: false, exitCode: e.exitCode, ...(op !== null ? { op } : {}), error: { code: e.code, message: e.message, wi: e.wi, detail: e.detail } })}\n`;
  return `${op !== null ? `Operation id: ${op}\n` : ''}Error (${e.code}${e.wi ? `, ${e.wi}` : ''}): ${e.message}\n`;
}

/** Run one CLI invocation in this process (the tests use it directly). */
export async function runCli(argv: readonly string[], io: CliIo): Promise<CliOutput> {
  const [name, ...rest] = argv;
  const wantsJson = rest.includes('--json');
  if (name === undefined || name === 'help' || name === '--help') return { exitCode: name === undefined ? EXIT.USAGE : 0, stdout: `${help()}\n`, stderr: '' };
  const cmd = COMMANDS.find((c) => c.name === name);
  if (cmd === undefined) return { exitCode: EXIT.USAGE, stdout: '', stderr: renderError(new CliError('USAGE', `unknown command ${name}; mp help lists all commands`, { exitCode: EXIT.USAGE }), wantsJson, null) };
  let args: ParsedArgs;
  let op: string | null = null;
  let ctx: Ctx | null = null;
  try {
    args = parseArgs(rest, cmd.flags);
    if (flagBool(args, 'help')) return { exitCode: 0, stdout: `${cmd.summary}\nUsage: ${cmd.usage}\n`, stderr: '' };
    const json = flagBool(args, 'json');
    const configFlag = flagStr(args, 'config');
    const path = findConfigPath(configFlag, io.env);
    if (cmd.noConfig === true) {
      // install: the configuration is what it writes (the flag, $MP_CONFIG, or the default place).
      const target = configFlag !== null ? resolve(configFlag) : io.env['MP_CONFIG'] ? resolve(io.env['MP_CONFIG']) : defaultConfigPath(io.env);
      ctx = new Ctx(PLACEHOLDER_CONFIG, target, io);
    } else {
      if (path === null) throw new CliError('NO_CONFIG', 'no configuration found (--config, $MP_CONFIG or ~/.config/mission-pipeline/engine4.json): run mp install first', { exitCode: EXIT.NO_CONFIG });
      ctx = new Ctx(loadCliConfig(path), path, io);
    }
    let replay = false;
    let result: CommandResult;
    if (cmd.changesState && cmd.noConfig !== true) {
      op = checkOpId(flagStr(args, 'op') ?? newOpId(cmd.name, io.now()));
      const identity = cmd.identity ? cmd.identity(args) : { positionals: args.positionals, flags: Object.fromEntries(Object.entries(args.flags).filter(([k]) => !(k in GLOBAL_FLAGS))) };
      let begun: { replay: { result: unknown; state: string } | null } = { replay: null };
      try {
        begun = ctx.journal.begin(op, cmd.name, identity, cmd.wi ?? null, io.now());
      } catch (e) {
        // A conflict is the caller's mistake; a journal that cannot be written never blocks the action (a stop above all).
        if (e instanceof CliError && e.code === 'OP_CONFLICT') throw e;
      }
      // The ledger's record of the PM's action (3.11 principle 3; recordPmAction); best effort while the ledger is down,
      // except that the ledger knowing this op id with other arguments is the same conflict.
      const record = async (state: 'started' | 'done' | 'failed', res: unknown): Promise<void> => {
        const client = ctx!.ledger(1_500);
        try {
          await client.call('recordPmAction', { action: op!, command: cmd.name, args: identity, wi: cmd.wi ?? null, state, ...(res !== undefined ? { result: pmResult(res) } : {}) });
        } catch (e) {
          if ((e as { code?: string }).code === 'OP_CONFLICT') throw new CliError('OP_CONFLICT', `operation id ${op} was already used for another command or other arguments (the ledger's record); use a new operation id`, { exitCode: EXIT.OP_CONFLICT });
        } finally {
          client.close();
        }
      };
      // a stop never waits for anything: its action is recorded after it ran
      if (begun.replay === null && cmd.name !== 'stop') await record('started', undefined);
      if (begun.replay !== null) {
        replay = true;
        const prior = begun.replay.result as { exitCode: number; text: string; json: unknown } | null;
        result = { exitCode: prior?.exitCode ?? 0, text: prior?.text ?? '(the original result was not recorded)', json: prior?.json ?? null };
      } else {
        try {
          result = await cmd.run(ctx, args, op);
        } catch (e) {
          try {
            ctx.journal.finish(op, 'failed', { error: errorMessage(e), code: e instanceof CliError ? e.code : 'FAILED' }, io.now());
          } catch {
            /* best effort */
          }
          await record('failed', { error: errorMessage(e), code: e instanceof CliError ? e.code : 'FAILED' }).catch(() => undefined);
          throw e;
        }
        try {
          ctx.journal.finish(op, result.exitCode === 0 ? 'done' : 'failed', { exitCode: result.exitCode, text: result.text, json: result.json }, io.now());
        } catch {
          /* best effort */
        }
        await record(result.exitCode === 0 ? 'done' : 'failed', { exitCode: result.exitCode, json: result.json }).catch(() => undefined);
      }
    } else {
      result = await cmd.run(ctx, args, null);
    }
    return { exitCode: result.exitCode, stdout: render(result, json, op, replay), stderr: '' };
  } catch (e) {
    const err = e instanceof CliError ? e : new CliError('FAILED', `program internal error: ${errorMessage(e)} (WI-20: tell the maintainer)`, { exitCode: EXIT.FAILED, wi: 'WI-20' });
    return { exitCode: err.exitCode, stdout: wantsJson ? renderError(err, true, op) : '', stderr: wantsJson ? '' : renderError(err, false, op) };
  } finally {
    ctx?.close();
  }
}

/** A command's result as the ledger keeps it: bounded (a record is at most 64 KiB). */
function pmResult(r: unknown): unknown {
  const s = JSON.stringify(r ?? null);
  return s.length <= 16_000 ? r : { truncated: true, head: s.slice(0, 16_000) };
}

const PLACEHOLDER_CONFIG: CliConfig = parseCliConfig({ format: CLI_CONFIG_FORMAT, ledgerRoot: '/nonexistent', controlPlane: '/nonexistent', ledgerSocket: '/nonexistent', stateDir: '/nonexistent', projects: [] });

async function main(): Promise<void> {
  const out = await runCli(process.argv.slice(2), { cwd: process.cwd(), env: process.env, now: Date.now });
  if (out.stdout) process.stdout.write(out.stdout);
  if (out.stderr) process.stderr.write(out.stderr);
  process.exitCode = out.exitCode;
}

const self = fileURLToPath(import.meta.url);
let invoked = '';
try {
  invoked = realpathSync(process.argv[1] ?? '');
} catch {
  invoked = '';
}
if (invoked === self) {
  main().then(
    // Detached stop writers and sockets must not keep the CLI alive.
    () => setTimeout(() => process.exit(process.exitCode ?? 0), 10).unref(),
    (e: unknown) => {
      process.stderr.write(`Error: ${errorMessage(e)}\n`);
      process.exit(EXIT.FAILED);
    },
  );
}
