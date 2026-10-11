// What every `mp` command starts with (design 4.1 §3.3, §4.1, §6.5, §6.7; decision 8):
//
//   1. find the project: `--project <dir>`, else $MP_PROJECT, else the nearest folder upwards
//      that holds `.mission-pipeline/memory.db` (a seat's worktree or checkout under
//      `.mission-pipeline/` finds the project it belongs to);
//   2. open the memory: a copied or moved folder is recovered first (A1, under the maintenance
//      lock), and the memory's status is surfaced: a broken event chain (WI-29), git writes held
//      (WI-31), what the recovery after a move found (WI-30, WI-31), leaves of an unfinished write;
//   3. landing intents left without a result are checked (A4 recoverLandings): "landing in
//      progress" while another `mp` holds the landing lock, else each judged by its target ref;
//   4. before a command that decides on labels: the environment identity is observed (A2), and a
//      change is reported (`mp pm renew` restores proof without a seat).
//
// The PM's commands are attributed to the latest PM session (`mp pm session --filled-by`, decision
// 8) and recorded as PM actions under an operation id: the same id again with the same arguments
// replays the recorded result; with other arguments it is refused (OP_CONFLICT).

import { existsSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { canonicalJson, sha256 } from '../common/hash.ts';
import { recoverLandings, type LandingResult } from '../git/land.ts';
import { PlainGit } from '../git/plainGit.ts';
import { pmAction, recordPmAction, type Filler, type Memory } from '../memory/index.ts';
import { openProcess, type ProcessContext, type ProcessOptions } from '../process/index.ts';
import { defaultConfig, readConfig, type ProjectConfig } from './config.ts';
import { CliError, EXIT, errorMessage, wi41 } from './errors.ts';

export interface CliIo {
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly now?: () => number;
  /** The standard input, read whole (`mp pm say --stdin`). */
  readonly stdin?: () => string;
  /** Tests: options for the process context (an environment observation, a clock). */
  readonly process?: ProcessOptions;
}

/** Something the PM should know before the command's own answer (each names its WI, or none). */
export interface Problem {
  readonly code: string;
  readonly message: string;
  readonly wi: string | null;
}

const MEMORY = '.mission-pipeline';

function hasMemory(dir: string): boolean {
  return existsSync(join(dir, MEMORY, 'memory.db'));
}

/** The project folder `mp` works in, or null. */
export function findProject(cwd: string, flag: string | null, env: Readonly<Record<string, string | undefined>>): string | null {
  const given = flag ?? (env['MP_PROJECT'] !== undefined && env['MP_PROJECT'] !== '' ? env['MP_PROJECT'] : null);
  if (given !== null) {
    const dir = resolve(cwd, given);
    if (hasMemory(dir)) return dir;
    if (basename(dir) === MEMORY && existsSync(join(dir, 'memory.db'))) return dirname(dir);
    return null;
  }
  let dir = resolve(cwd);
  for (;;) {
    if (hasMemory(dir)) return dir;
    if (basename(dir) === MEMORY && existsSync(join(dir, 'memory.db'))) return dirname(dir);
    const up = dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

export interface Project {
  readonly dir: string;
  readonly config: ProjectConfig;
  readonly ctx: ProcessContext;
  readonly problems: Problem[];
  /** The landings this command's start recorded or found open (§6.7 recovery). */
  readonly landings: readonly LandingResult[];
  close(): void;
}

function moveProblems(memory: Memory, since: number): Problem[] {
  const st = memory.status();
  const out: Problem[] = [];
  if (st.lastMove !== null && st.lastMove.at >= since) {
    const f = st.lastMove.findings;
    out.push({ code: 'MOVED', wi: null, message: `this folder was copied or moved (from ${st.lastMove.from.path} on ${st.lastMove.from.machine} to ${st.lastMove.to.path}): the memory was checked and its state rebuilt from the event log` });
    if (f.leaves.missingCount + f.leaves.editedCount > 0) {
      out.push({
        code: 'LEAVES',
        wi: 'WI-30',
        message: `${f.leaves.missingCount} leaf(s) missing and ${f.leaves.editedCount} edited after they were recorded (${[...f.leaves.missing, ...f.leaves.edited].slice(0, 5).join(', ')}): only the steps that need them are held`,
      });
    }
    if (f.commits.unreachableCount > 0) out.push({ code: 'COMMITS', wi: 'WI-30', message: `${f.commits.unreachableCount} commit(s) the memory names are not reachable here (${f.commits.unreachable.slice(0, 5).join(', ')}): only the steps that need them are held` });
    for (const w of f.layout) out.push({ code: 'LAYOUT', wi: 'WI-31', message: w });
  }
  return out;
}

/** The memory's own state, as problems (§3.3). */
export function statusProblems(memory: Memory): Problem[] {
  const st = memory.status();
  const out: Problem[] = [];
  if (st.chainBroken !== null) {
    const c = st.chainBroken;
    out.push({
      code: 'CHAIN_BROKEN',
      wi: 'WI-29',
      message: `the memory's event chain is broken${c.brokenAt !== null ? ` at event ${c.brokenAt}` : ''} (${c.reason ?? 'broken'}); the last valid event is ${c.lastValid}. Every write is refused: copy the folder again from its source, or \`mp pm continue-from ${c.lastValid}\``,
    });
  }
  if (st.gitHold !== null) out.push({ code: 'GIT_WRITES_HELD', wi: 'WI-31', message: `git writes are held since this folder was moved or copied (${st.gitHold.reason}): once this copy is the one in use, \`mp pm confirm-copy\`` });
  if (st.movePending !== null) out.push({ code: 'MOVING', wi: null, message: `another mp is recovering this folder after a move (from ${st.movePending.from.path}): retry once it is done` });
  if (st.pendingLeaves) out.push({ code: 'PENDING_LEAVES', wi: null, message: 'a write did not finish; its leaves are removed by the next write' });
  return out;
}

function landingProblems(results: readonly LandingResult[]): Problem[] {
  const out: Problem[] = [];
  for (const r of results) {
    if (r.kind === 'landed') out.push({ code: 'LANDED', wi: r.worktree !== null && r.worktree.relation !== 'consistent' ? 'WI-04' : null, message: `landing of delivery ${r.delivery} (mission ${r.mission}) recorded as landed: ${r.branch} is at ${r.commit}` });
    else if (r.kind === 'open') out.push({ code: 'LANDING_OPEN', wi: 'WI-06', message: `landing intent ${r.intent} is open (class ${r.class}): ${r.detail}` });
    else if (r.kind === 'in-progress') out.push({ code: 'LANDING_IN_PROGRESS', wi: 'WI-06', message: 'a landing is in progress (another mp holds the landing lock); nothing was touched' });
  }
  return out;
}

/**
 * Open the project for one command: the memory (recovered after a move), its problems, the
 * landing recovery, and for a deciding command the environment identity.
 */
export async function openProject(io: CliIo, o: { readonly flag: string | null; readonly decides: boolean; readonly recover?: boolean; readonly readsConfig?: boolean; readonly filler?: Filler | null }): Promise<Project> {
  const dir = findProject(io.cwd, o.flag, io.env);
  if (dir === null) throw new CliError('NOT_INITIALIZED', `no Mission Pipeline memory here (${o.flag ?? io.cwd}): run \`mp init\` in the project folder, or give --project <dir>`, { exitCode: EXIT.NO_PROJECT });
  // a stop (Appendix E) never reads config.json: a broken or missing one never blocks it; the defaults stand in where the context needs a value
  const config = o.readsConfig === false ? defaultConfig({ targetBranch: 'main', versionCommands: [] }) : readConfig(dir);
  const startedAt = Date.now();
  const git = io.process?.git ?? PlainGit.create();
  const ctx = openProcess(dir, { git, targetBranch: config.targetBranch, commandTimeoutMs: config.commandTimeoutMs, filler: o.filler ?? null, ...(io.process ?? {}) });
  const problems: Problem[] = [];
  let landings: LandingResult[] = [];
  try {
    problems.push(...statusProblems(ctx.memory), ...moveProblems(ctx.memory, startedAt - 1));
    if (o.recover !== false) {
      try {
        const r = await recoverLandings(ctx.gitCtx);
        if (r.kind === 'in-progress') problems.push({ code: 'LANDING_IN_PROGRESS', wi: 'WI-06', message: `a landing is in progress (${r.intents.join(', ')}): nothing was touched` });
        else {
          landings = [...r.results];
          problems.push(...landingProblems(r.results));
        }
      } catch (e) {
        // a broken chain refuses the recovery's records: already reported above
        if ((e as { code?: string }).code !== 'CHAIN_BROKEN') problems.push({ code: 'LANDING_CHECK', wi: wi41((e as { wi?: string }).wi ?? null), message: `the open landing intents could not be checked now: ${errorMessage(e)}` });
      }
    }
    // a deciding command observes the environment first (§6.5), and so does any command that just recovered a moved folder
    if (o.decides || (o.recover !== false && problems.some((x) => x.code === 'MOVED'))) {
      try {
        const env = ctx.environment();
        if (env.changed && env.previous !== null) problems.push({ code: 'ENVIRONMENT', wi: null, message: `the environment identity changed (${env.previous.slice(0, 12)} → ${env.identity.slice(0, 12)}): runs under the old identity need a rerun; \`mp pm next\` offers \`mp pm renew\`` });
      } catch (e) {
        if ((e as { code?: string }).code !== 'CHAIN_BROKEN') problems.push({ code: 'ENVIRONMENT', wi: null, message: `the environment identity could not be observed: ${errorMessage(e)}` });
      }
    }
  } catch (e) {
    ctx.memory.close();
    throw e;
  }
  return { dir, config, ctx, problems, landings, close: () => ctx.memory.close() };
}

// ---------------------------------------------------------------- PM sessions and actions (decision 8)

/** The latest PM session: its id and the filler it recorded. */
export function latestSession(memory: Memory): { readonly session: string; readonly filler: Filler | null; readonly at: number } | null {
  return memory.read((db) => {
    const r = db.stmt("SELECT action, args, started_at FROM pm_actions WHERE command = 'session' ORDER BY rev DESC LIMIT 1").get() as { action: string; args: string; started_at: number } | undefined;
    if (r === undefined) return null;
    let filler: Filler | null = null;
    try {
      const a = JSON.parse(memory.data.text(r.args)) as { args?: { filler?: Filler | null } };
      filler = a.args?.filler ?? null;
    } catch {
      filler = null;
    }
    return { session: r.action, filler, at: Number(r.started_at) };
  });
}

const ACTION_ID = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,199}$/;

/** A new operation id for a PM command (printed, so a retry can name it with --op). */
export function newOpId(command: string, now: number): string {
  return `${command.replace(/[^A-Za-z0-9-]/g, '-')}-${now.toString(36)}-${sha256(`${now}:${Math.random()}`).slice(0, 6)}`;
}

export function checkOpId(op: string): string {
  if (!ACTION_ID.test(op)) throw new CliError('USAGE', `an operation id is 1 to 200 letters, digits and "._:@-", starting with a letter or digit: ${JSON.stringify(op)}`, { exitCode: EXIT.USAGE });
  return op;
}

export interface Recorded {
  readonly exitCode: number;
  readonly text: string;
  readonly json: unknown;
}

/** The arguments as an action records them: long strings by their hash (an action's arguments are at most 256 KiB). */
export function actionArgs(x: unknown): unknown {
  if (typeof x === 'string') return x.length > 1000 ? { sha256: sha256(x), length: x.length } : x;
  if (Array.isArray(x)) return x.map(actionArgs);
  if (x !== null && typeof x === 'object') return Object.fromEntries(Object.entries(x).map(([k, v]) => [k, actionArgs(v)]));
  return x;
}

/**
 * Begin a PM action (its op receipt carries the command and the PM's filler, §3.2 item 13). An
 * action already done under this id with these arguments returns its recorded result instead.
 */
export function beginAction(memory: Memory, a: { readonly op: string; readonly command: string; readonly args: unknown; readonly filler: Filler | null; readonly wi?: string | null }): Recorded | null {
  const prior = memory.read((db) => pmAction(db, a.op));
  const argsHash = sha256(canonicalJson({ command: a.command, args: a.args ?? null }));
  if (prior !== null) {
    if (prior.command !== a.command || prior.argsHash !== argsHash) throw new CliError('OP_CONFLICT', `operation id ${a.op} was already used for another command or other arguments (${prior.command}): use a new operation id`, { exitCode: EXIT.OP_CONFLICT });
    if (prior.state === 'done' && prior.result !== null) {
      try {
        const r = JSON.parse(memory.data.text(prior.result)) as Recorded;
        return { exitCode: r.exitCode ?? 0, text: r.text ?? '', json: r.json ?? null };
      } catch {
        return { exitCode: 0, text: '(the original result cannot be read)', json: null };
      }
    }
  }
  memory.write({ op: `pm:${a.op}`, payload: { command: a.command, args: a.args ?? null }, command: a.command, filler: a.filler }, (tx) => {
    recordPmAction(tx, { action: a.op, command: a.command, args: a.args, wi: a.wi ?? null, state: 'started' });
    return { started: a.op };
  });
  return null;
}

/** End a PM action with its result (best effort: the command's own records are already committed). */
export function endAction(memory: Memory, a: { readonly op: string; readonly command: string; readonly args: unknown; readonly wi?: string | null }, r: Recorded, failed: boolean): void {
  const bounded = (s: string): string => (s.length <= 16_000 ? s : `${s.slice(0, 16_000)}…`);
  const json = JSON.stringify(r.json ?? null);
  const result = { exitCode: r.exitCode, text: bounded(r.text), json: json.length <= 64_000 ? r.json : { truncated: true } };
  try {
    memory.write({}, (tx) => {
      recordPmAction(tx, { action: a.op, command: a.command, args: a.args, wi: a.wi ?? null, state: failed ? 'failed' : 'done', result });
    });
  } catch {
    /* the action stays "started": a retry with the same --op runs it again (its writes are idempotent) */
  }
}
