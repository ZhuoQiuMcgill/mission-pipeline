// `mp`: the command line of Mission Pipeline 4.1 (design §4.1), the only way to read and write the
// project memory. Text for people by default, `--json` for programs. Groups by role:
//
//   mp pm …                 the PM (§5.1: next, dispatch, release, …; the alignment and delivery commands)
//   mp seat <dispatch> …    a dispatched seat (card, read, checkout, rerun, handback, request-evidence)
//   mp read …               anyone: status, show, leaf, why, from, chain, tree
//   mp init | config | recompute | docs update | help
//
// Every command opens the project's memory itself (no service), surfaces what the PM must know
// first (project.ts), runs, and exits. Every `mp pm` command carries an operation id (`--op`, or
// a generated one, printed): the same id with the same arguments returns the recorded result.
//
//   node --experimental-strip-types src/cli/main.ts <group> <command> [args] [--json] [--project <dir>]
//   (installed: `mp`, bin/mp.mjs)

import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import '../evaluator/index.ts';
import { GLOBAL_FLAGS, flagBool, flagStr, parseArgs, type ParsedArgs } from './args.ts';
import { commandName, type Command, type CommandResult, type RunContext } from './command.ts';
import { ADMIN_COMMANDS, mpVersion } from './commands/admin.ts';
import { PM_COMMANDS } from './commands/pm.ts';
import { READ_COMMANDS } from './commands/read.ts';
import { SEAT_COMMANDS } from './commands/seat.ts';
import { CliError, EXIT, errorMessage, toCliError, usage } from './errors.ts';
import { actionArgs, beginAction, checkOpId, endAction, latestSession, newOpId, openProject, type CliIo, type Problem, type Project } from './project.ts';
import { problemLines, wiText } from './render.ts';
import { parseFiller } from '../process/index.ts';

export const COMMANDS: readonly Command[] = [...PM_COMMANDS, ...SEAT_COMMANDS, ...READ_COMMANDS, ...ADMIN_COMMANDS];

export interface CliOutput {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** PM commands whose first positional is a sub-command (recorded as "<command> <sub>"). */
const WITH_SUB = new Set(['requirement', 'constraint', 'plan', 'legalize', 'mission']);

function groupHelp(group: string): string {
  const cs = COMMANDS.filter((c) => c.group === group);
  const w = Math.max(...cs.map((c) => commandName(c).length));
  return cs.map((c) => `  mp ${commandName(c).padEnd(w)}  ${c.summary}`).join('\n');
}

export function help(group?: string): string {
  if (group === 'pm' || group === 'seat' || group === 'read') return `mp ${group}: ${group === 'pm' ? 'the PM\'s commands' : group === 'seat' ? 'a dispatched seat\'s commands (its card lists the ones it may use)' : 'the reads (layered, and the tree reads)'}\n\n${groupHelp(group)}\n\nUsage of one command: mp ${group} ${group === 'seat' ? '<dispatch> ' : ''}<command> --help`;
  return [
    `mp ${mpVersion()}: Mission Pipeline — an objective project memory, role descriptions and a process.`,
    '',
    'The project:',
    groupHelp('admin'),
    '',
    'The PM (any harness that can run a shell command):',
    groupHelp('pm'),
    '',
    'A dispatched seat:',
    groupHelp('seat'),
    '',
    'Reading:',
    groupHelp('read'),
    '',
    'Global options: --json (machine-readable), --project <dir> (default: the nearest folder upwards with .mission-pipeline/), --op <id> (a PM command\'s operation id, for a retry), --help',
    'Exit codes: 0 done; 3 refused (a WI may apply); 64 bad arguments; 65 operation id reused with other arguments; 75 busy, retry (nothing was written); 78 no memory here (mp init); 1 internal error (WI-20).',
  ].join('\n');
}

function find(argv: readonly string[]): { cmd: Command; rest: string[] } | { help: string } | { error: CliError } {
  const [g, ...rest] = argv;
  if ((g === 'help' || g === '--help') && rest.length > 0) {
    // `mp help pm plan`, `mp help seat handback`, `mp help init`: one command's usage
    const [group, ...words] = rest;
    const name = group === 'pm' || group === 'read' || group === 'seat' ? words.filter((w) => !w.startsWith('<'))[0] : group;
    const cmd = name === undefined ? undefined : COMMANDS.find((c) => c.name[0] === name && (c.group === group || (c.group === 'admin' && group === name)));
    if (cmd !== undefined) return { help: `${cmd.summary}\nUsage: ${cmd.usage}` };
    return { help: help(group) };
  }
  if (g === undefined || g === 'help' || g === '--help' || g === '-h') return { help: help(rest[0]) };
  if (g === '--version' || g === 'version') return { help: mpVersion() };
  if (g === 'pm' || g === 'read') {
    const name = rest[0];
    if (name === undefined || name === '--help' || name === 'help') return { help: help(g) };
    const cmd = COMMANDS.find((c) => c.group === g && c.name[0] === name);
    return cmd === undefined ? { error: usage(`unknown command mp ${g} ${name}; mp ${g} --help lists them`) } : { cmd, rest: rest.slice(1) };
  }
  if (g === 'seat') {
    const [dispatch, name, ...more] = rest;
    if (dispatch === undefined || dispatch === '--help' || dispatch === 'help') return { help: help('seat') };
    if (name === undefined || name === '--help') return { help: help('seat') };
    const cmd = COMMANDS.find((c) => c.group === 'seat' && c.name[0] === name);
    return cmd === undefined ? { error: usage(`unknown command mp seat ${dispatch} ${name}; your card lists your commands`) } : { cmd, rest: [dispatch, ...more] };
  }
  const cmd = COMMANDS.find((c) => c.group === 'admin' && c.name[0] === g);
  return cmd === undefined ? { error: usage(`unknown command ${g}; mp help lists all commands`) } : { cmd, rest };
}

function render(r: CommandResult, o: { json: boolean; op: string | null; replayed: boolean; problems: readonly Problem[]; project: string | null; command: string }): string {
  if (o.json) return `${JSON.stringify({ ok: r.exitCode === 0, exitCode: r.exitCode, command: o.command, ...(o.op !== null ? { op: o.op, replayed: o.replayed } : {}), problems: o.problems, result: r.json })}\n`;
  const head = problemLines(o.problems, o.project);
  const tail = o.op !== null ? [`(operation ${o.op}${o.replayed ? ': already done; its recorded result is shown, nothing ran again' : ''})`] : [];
  return `${[...head, r.text, ...tail].filter((x) => x !== '').join('\n')}\n`;
}

function renderError(e: CliError, json: boolean, op: string | null, problems: readonly Problem[], project: string | null): string {
  if (json) return `${JSON.stringify({ ok: false, exitCode: e.exitCode, ...(op !== null ? { op } : {}), problems, error: { code: e.code, message: e.message, wi: e.wi, detail: e.detail } })}\n`;
  const wi = e.wi !== null ? ` [${wiText(e.wi, project)}]` : '';
  return `${[...problemLines(problems, project), `Error (${e.code}): ${e.message}${wi}`, ...(op !== null ? [`(operation ${op})`] : [])].join('\n')}\n`;
}

/** The arguments that identify a PM operation: its positionals and flags, without the global ones. */
function identityOf(cmd: Command, args: ParsedArgs): unknown {
  if (cmd.identity !== undefined) return actionArgs(cmd.identity(args));
  return actionArgs({ positionals: args.positionals, flags: Object.fromEntries(Object.entries(args.flags).filter(([k]) => !(k in GLOBAL_FLAGS) && k !== 'filled-by')) });
}

/** Run one invocation in this process (the tests use it directly; bin/mp.mjs runs main below). */
export async function runCli(argv: readonly string[], io: CliIo): Promise<CliOutput> {
  const wantsJson = argv.includes('--json');
  const found = find(argv);
  if ('help' in found) return { exitCode: argv.length === 0 ? EXIT.USAGE : 0, stdout: `${found.help}\n`, stderr: '' };
  if ('error' in found) return { exitCode: found.error.exitCode, stdout: wantsJson ? renderError(found.error, true, null, [], null) : '', stderr: wantsJson ? '' : renderError(found.error, false, null, [], null) };
  const { cmd, rest } = found;
  const now = (io.now ?? Date.now)();
  let project: Project | null = null;
  let op: string | null = null;
  let problems: readonly Problem[] = [];
  try {
    const spec = cmd.group === 'pm' && cmd.flags['filled-by'] === undefined ? { ...cmd.flags, 'filled-by': 'string' as const } : cmd.flags;
    const args = parseArgs(rest, spec);
    if (flagBool(args, 'help')) return { exitCode: 0, stdout: `${cmd.summary}\nUsage: ${cmd.usage}\n`, stderr: '' };
    const json = flagBool(args, 'json');
    if (cmd.noProject !== true) {
      project = await openProject(io, { flag: flagStr(args, 'project'), decides: cmd.decides === true && cmd.stop !== true, recover: cmd.stop !== true, readsConfig: cmd.stop !== true });
      problems = project.problems;
    }
    let replayed = false;
    let result: CommandResult;
    if (cmd.group === 'pm' && project !== null) {
      op = checkOpId(flagStr(args, 'op') ?? newOpId(cmd.name[0]!, now));
      // decision 8: the PM's filler is the latest session's (`--filled-by` overrides it; on dispatch it names the seat's filler)
      const session = latestSession(project.ctx.memory);
      const own = cmd.name[0] === 'dispatch' ? null : parseFiller(flagStr(args, 'filled-by'));
      project.ctx.filler = own ?? session?.filler ?? null;
      const action = { op, command: [cmd.name[0]!, ...(WITH_SUB.has(cmd.name[0]!) && args.positionals[0] !== undefined ? [args.positionals[0]] : [])].join(' '), args: identityOf(cmd, args), stop: cmd.stop === true };
      const c: RunContext = { io, project, op, now };
      if (cmd.unrecorded === true) result = await cmd.run(c, args);
      else if (cmd.stop === true) {
        // Appendix E: the stop is written first; its PM action is recorded after it
        result = await cmd.run(c, args);
        try {
          if (beginAction(project.ctx.memory, { ...action, filler: project.ctx.filler }) === null) endAction(project.ctx.memory, action, result, result.exitCode !== 0);
        } catch {
          /* the stop is written; its action record is best effort */
        }
      } else {
        const prior = beginAction(project.ctx.memory, { ...action, filler: project.ctx.filler });
        if (prior !== null) {
          replayed = true;
          result = prior;
        } else {
          try {
            result = await cmd.run(c, args);
          } catch (e) {
            const err = toCliError(e);
            endAction(project.ctx.memory, action, { exitCode: err.exitCode, text: `Error (${err.code}): ${err.message}`, json: { error: { code: err.code, message: err.message, wi: err.wi } } }, true);
            throw err;
          }
          endAction(project.ctx.memory, action, result, result.exitCode !== 0);
        }
      }
    } else {
      result = await cmd.run({ io, project, op: null, now }, args);
    }
    return { exitCode: result.exitCode, stdout: render(result, { json, op, replayed, problems, project: project?.dir ?? null, command: commandName(cmd) }), stderr: '' };
  } catch (e) {
    const err = toCliError(e);
    const dir = project?.dir ?? null;
    return { exitCode: err.exitCode, stdout: wantsJson ? renderError(err, true, op, problems, dir) : '', stderr: wantsJson ? '' : renderError(err, false, op, problems, dir) };
  } finally {
    project?.close();
  }
}

async function main(): Promise<void> {
  const out = await runCli(process.argv.slice(2), {
    cwd: process.cwd(),
    env: process.env,
    stdin: () => readFileSync(0, 'utf8'),
  });
  if (out.stdout) process.stdout.write(out.stdout);
  if (out.stderr) process.stderr.write(out.stderr);
  process.exitCode = out.exitCode;
}

function real(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return '';
  }
}
const self = real(fileURLToPath(import.meta.url));
if (self !== '' && real(process.argv[1] ?? '') === self) {
  main().then(
    () => setTimeout(() => process.exit(process.exitCode ?? 0), 10).unref(),
    (e: unknown) => {
      process.stderr.write(`Error: ${errorMessage(e)}\n`);
      process.exit(EXIT.FAILED);
    },
  );
}
