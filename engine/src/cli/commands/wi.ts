// WI actions that are not about delivery (design 3.11): WI-11 retry the evaluator,
// WI-22 retry a restart-exhausted service, WI-08 relay the user's grant after the
// Secretary's one grant, WI-09 the spend limit and the model configuration.

import { existsSync, readFileSync } from 'node:fs';
import { canonicalJson } from '../../common/hash.ts';
import { LOOP_KINDS, type LoopKind } from '../../common/records.ts';
import { writeFileAtomic } from '../../common/fsx.ts';
import { DEFAULT_MODEL_CONFIG, parseModelConfig, type Effort, type ModelConfig } from '../../seat/modelConfig.ts';
import { requestRetry, retryRequestPath, watchdogStatusPath } from '../../scheduler/watchdog.ts';
import { flagBool, flagStr, missionArg, positional } from '../args.ts';
import type { Command } from '../command.ts';
import { ok } from '../command.ts';
import type { Ctx } from '../context.ts';
import { CliError, EXIT, NotImplemented, errorMessage, usage } from '../errors.ts';
import { subOp } from '../ops.ts';

export const retryEvaluatorCmd: Command = {
  name: 'retry-evaluator',
  summary: 'WI-11 option 1: retry the evaluator (the failure count is cleared; it restarts)',
  usage: 'mp retry-evaluator',
  flags: {},
  changesState: true,
  wi: 'WI-11',
  async run(ctx) {
    await ctx.sched('retryEvaluator', {});
    return ok('Evaluator retry started: the failure count is cleared and the evaluator restarts; operations ended for this reason are registered again after the next successful publication. The same cause a second time: do not keep retrying (WI-11 option 4).', { retried: true });
  },
};

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export const retryServiceCmd: Command = {
  name: 'retry-service',
  summary: 'WI-22: after restarts are exhausted, retry once (the PM once per episode; after that the user decides)',
  usage: 'mp retry-service <ledger|scheduler> [--by-user]',
  flags: { 'by-user': 'boolean' },
  changesState: true,
  wi: 'WI-22',
  async run(ctx: Ctx, args) {
    const name = positional(args, 0, 'service (ledger or scheduler)');
    if (name !== 'ledger' && name !== 'scheduler') throw usage('the service is ledger or scheduler');
    const by = flagBool(args, 'by-user') ? 'user' : 'pm';
    type WdStatus = { at?: number; processes?: Array<{ name: string; state: string; exhaustedSince: number | null }> };
    let wd: WdStatus | null = null;
    try {
      wd = JSON.parse(readFileSync(watchdogStatusPath(ctx.config.controlPlane), 'utf8')) as WdStatus;
    } catch {
      wd = null;
    }
    if (wd === null) throw new CliError('UNAVAILABLE', 'the watchdog is not running (no status file): run mp ensure-running first', { exitCode: EXIT.UNAVAILABLE, wi: 'WI-22' });
    const p = wd.processes?.find((x) => x.name === name);
    if (p === undefined || p.state !== 'restart-exhausted') return ok(`${name} is not restart-exhausted (${p?.state ?? 'unknown'}); no retry needed.`, { service: name, state: p?.state ?? null, requested: false });
    requestRetry(ctx.config.controlPlane, name, by);
    // The watchdog takes the request on its next round (it alone decides: once per episode for the PM).
    const end = Date.now() + 5_000;
    while (existsSync(retryRequestPath(ctx.config.controlPlane, name)) && Date.now() < end) await sleep(100);
    const taken = !existsSync(retryRequestPath(ctx.config.controlPlane, name));
    return ok(
      `${taken ? 'The watchdog took' : 'Submitted'} the ${by === 'user' ? "user's" : "PM's"} retry request for ${name}. The PM has one retry per exhausted episode; when refused, the watchdog sends a WI-22 notice and the user decides (--by-user).`,
      { service: name, by, requested: true, taken },
    );
  },
};

interface LoopStateView {
  readonly attempts: number;
  readonly allowed: number;
  readonly exhausted: boolean;
  readonly reason: string | null;
  readonly secretaryGrantUsed: boolean;
}

export const grantCmd: Command = {
  name: 'grant',
  summary: 'WI-08: after the Secretary used its one extra grant, relay the extra attempts the user grants',
  usage: 'mp grant <lineage> <loop> --extra <n> --reason "<the user\'s words>"',
  flags: { extra: 'string', reason: 'string' },
  changesState: true,
  wi: 'WI-08',
  async run(ctx, args, op) {
    const lineage = positional(args, 0, 'lineage');
    const loop = positional(args, 1, `loop (${LOOP_KINDS.join(', ')})`);
    if (!LOOP_KINDS.includes(loop as LoopKind)) throw usage(`the loop is one of ${LOOP_KINDS.join(', ')}`);
    const extra = Number(flagStr(args, 'extra') ?? '');
    if (!Number.isSafeInteger(extra) || extra < 1 || extra > 100) throw usage('--extra is an integer from 1 to 100');
    const reason = (flagStr(args, 'reason') ?? '').trim();
    if (reason === '') throw usage('--reason: the user\'s words; only the user can add more after the Secretary\'s grant (6.5)');
    const st = (await ctx.call('loopState', { lineage, loop })) as LoopStateView;
    if (!st.exhausted) return ok(`${loop} of lineage ${lineage} is not exhausted (${st.attempts}/${st.allowed}); nothing to grant.`, { granted: false, state: st }, EXIT.REFUSED);
    if (!st.secretaryGrantUsed) {
      throw new CliError('SECRETARY_FIRST', `the Secretary has not used its one extra grant on lineage ${lineage} yet: per WI-08 go through the Secretary first (one extra grant, or split, or change approach); the user's grant comes after that`, { exitCode: EXIT.REFUSED, wi: 'WI-08' });
    }
    let via = 'scheduler';
    try {
      const g = (await ctx.sched('grant', { lineage, loop, by: 'user', extra, reason, op })) as { granted: boolean; why?: string };
      if (!g.granted) return ok(`Not granted: ${g.why ?? 'refused'}`, { granted: false, why: g.why ?? null }, EXIT.REFUSED);
    } catch (e) {
      if (!(e instanceof CliError) || e.code !== 'UNAVAILABLE') throw e;
      // Without the scheduler the grant is still recorded; the next scheduler requeues the lineage from the ledger.
      via = 'ledger';
      const body = ctx.content().put(canonicalJson({ format: 'mp4.loop-grant-reason.v2', reason, by: 'user' }));
      await ctx.call('appendRecords', { op: subOp(op!, 'grant'), gen: null, records: [{ kind: 'loop.grant', lineage, loop: loop as LoopKind, by: 'user', extra, reason: body }] as never });
    }
    return ok(`Granted ${extra} more attempts to ${loop} of lineage ${lineage}, per the user's decision (through the ${via === 'scheduler' ? 'scheduler' : 'ledger service'}).`, { granted: true, via, lineage, loop, extra });
  },
};

/** "$12.50", "12.5", "unlimited" → micro-dollars or null. */
export function parseAmount(v: string): number | null | undefined {
  if (v === 'unlimited') return null;
  const m = /^\$?(\d+(?:\.\d{1,6})?)$/.exec(v.trim());
  if (!m) return undefined;
  const micros = Math.round(Number(m[1]) * 1_000_000);
  return Number.isSafeInteger(micros) && micros > 0 ? micros : undefined;
}

export const spendLimitCmd: Command = {
  name: 'spend-limit',
  summary: 'WI-09: set a mission\'s spend limit (an amount or unlimited; default unlimited)',
  usage: 'mp spend-limit <mission> <amount|unlimited>',
  flags: {},
  changesState: true,
  wi: 'WI-09',
  async run(ctx, args, op) {
    const mission = missionArg(args, 0);
    const raw = positional(args, 1, 'amount or unlimited');
    const micros = parseAmount(raw);
    if (micros === undefined) throw usage(`an amount is 12.5 or $12.5, or unlimited; not ${raw}`);
    if (micros === null) {
      // unlimited needs no gate (6.5): the ledger directly.
      await ctx.call('setSpendLimit', { op: subOp(op!, 'spend-limit'), mission: mission as never, micros: null });
      return ok(`Spend limit of mission ${mission}: unlimited (the metering proxy still meters every request).`, { mission, micros: null });
    }
    // A money limit only with a passing self-check item 9 (6.5): the scheduler's setSpendLimit holds that gate.
    let r: { set: boolean; why?: string };
    try {
      r = (await ctx.sched('setSpendLimit', { mission, micros, op })) as { set: boolean; why?: string };
    } catch (e) {
      if (e instanceof CliError && /unknown method/.test(e.message)) {
        throw new NotImplemented('setting a money spend limit', 'setSpendLimit { mission, micros, op } on the scheduler RPC (src/scheduler/main.ts), calling Scheduler.setSpendLimit (with the self-check item 9 gate and its WI-18 notice)');
      }
      throw e;
    }
    if (!r.set) return ok(`Not set: ${r.why ?? 'refused'}; the mission stays unlimited (WI-18).`, { mission, micros, set: false, why: r.why ?? null }, EXIT.REFUSED);
    return ok(`Spend limit of mission ${mission}: $${(micros / 1e6).toFixed(2)}.`, { mission, micros, set: true });
  },
};

const EFFORTS: readonly Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'];

function readModelConfig(path: string): { cfg: ModelConfig; raw: Record<string, unknown> } {
  if (!existsSync(path)) return { cfg: DEFAULT_MODEL_CONFIG, raw: { format: DEFAULT_MODEL_CONFIG.format, seats: { ...DEFAULT_MODEL_CONFIG.seats } } };
  const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  return { cfg: parseModelConfig(raw), raw };
}

export const modelConfigCmd: Command = {
  name: 'model-config',
  summary: 'show or change model_config.json (each seat\'s model and effort; seats started later use it; switching models invalidates no conclusion)',
  usage: 'mp model-config show | mp model-config set <seat> [--model <model>] [--effort low|medium|high|xhigh|max] [--max-output-tokens <n>]',
  flags: { model: 'string', effort: 'string', 'max-output-tokens': 'string' },
  changesState: true,
  wi: 'WI-09',
  async run(ctx, args) {
    const path = ctx.config.modelConfig;
    if (path === null) throw new CliError('NO_CONFIG', 'no path to model_config.json is configured (modelConfig)', { exitCode: EXIT.NO_CONFIG });
    const sub = positional(args, 0, 'show or set');
    const { cfg, raw } = readModelConfig(path);
    if (sub === 'show') {
      const lines = Object.entries(cfg.seats).map(([seat, m]) => `${seat}: ${m.model}${m.effort ? `, effort ${m.effort}` : ''}${m.maxOutputTokens ? `, max output ${m.maxOutputTokens}` : ''}`);
      return ok(lines.join('\n'), { path, seats: cfg.seats });
    }
    if (sub !== 'set') throw usage('model-config takes show or set');
    const seat = positional(args, 1, 'seat');
    const model = flagStr(args, 'model');
    const effort = flagStr(args, 'effort');
    const mot = flagStr(args, 'max-output-tokens');
    if (model === null && effort === null && mot === null) throw usage('set needs at least one of --model, --effort, --max-output-tokens');
    if (effort !== null && !EFFORTS.includes(effort as Effort)) throw usage(`--effort is one of ${EFFORTS.join(', ')}`);
    const seats = { ...((raw['seats'] as Record<string, Record<string, unknown>> | undefined) ?? {}) };
    const prev = seats[seat] ?? { provider: 'anthropic' };
    const next: Record<string, unknown> = { ...prev, provider: 'anthropic' };
    if (model !== null) next['model'] = model;
    if (effort !== null) next['effort'] = effort;
    if (mot !== null) {
      const n = Number(mot);
      if (!Number.isSafeInteger(n) || n <= 0) throw usage('--max-output-tokens is a positive integer');
      next['maxOutputTokens'] = n;
    }
    if (typeof next['model'] !== 'string') throw usage(`seat ${seat} has no model yet: give --model`);
    seats[seat] = next;
    const doc = { ...raw, seats };
    try {
      parseModelConfig(doc);
    } catch (e) {
      throw new CliError('BAD_MODEL_CONFIG', `not changed: ${errorMessage(e)}`, { exitCode: EXIT.REFUSED });
    }
    writeFileAtomic(path, `${JSON.stringify(doc, null, 2)}\n`);
    return ok(`Changed ${seat}: ${String(next['model'])}${next['effort'] ? `, effort ${String(next['effort'])}` : ''}. Seats started from now on use it.`, { path, seat, model: next });
  },
};
