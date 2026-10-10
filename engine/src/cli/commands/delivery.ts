// Delivery, landing and closing (design 6.6; WI-01, WI-02, WI-04, WI-05, WI-06, WI-13, WI-19, WI-21).
//
// The user says "deliver" (交付): that is also consent to land (method A, maintainer
// 2026-10-09). `mp deliver` builds the candidate and creates the delivery ref, then lands it
// at once (unless --no-land). `mp land` starts a new landing attempt of an existing delivery,
// or records the PM's choice to deliver the ref only. `mp withdraw-delivery` records the
// user's withdrawal (no landing or ref of it is authorized again). `mp close` closes a
// mission. Every outcome that is not "done" names its WI and the WI's page.

import type { DeliveryResult } from '../../delivery/deliver.ts';
import type { LandingReport } from '../../git/landing.ts';
import { flagBool, flagList, flagStr, missionArg, positional, type ParsedArgs } from '../args.ts';
import type { Command, CommandResult } from '../command.ts';
import { ok } from '../command.ts';
import { ledgerPathsOf, projectOf, type ProjectConfig } from '../config.ts';
import type { Ctx } from '../context.ts';
import { CliError, EXIT, usage } from '../errors.ts';
import { Layer2Reader, findDelivery, type DeliveryRecorded } from '../layer2.ts';
import { wiPagePath, wiTitle } from '../wi.ts';
import { deliveryAdapter, deliveryJson } from '../adapters/delivery.ts';

export function resolveProject(ctx: Ctx, flag: string | null): ProjectConfig {
  if (flag !== null) {
    const p = ctx.config.projects.find((x) => x.root === flag) ?? projectOf(ctx.config, flag);
    if (p === null || p === undefined) throw new CliError('NO_PROJECT', `${flag} is not a registered project (mp install registers it)`, { exitCode: EXIT.USAGE });
    return p;
  }
  const here = projectOf(ctx.config, ctx.io.cwd);
  if (here !== null) return here;
  if (ctx.config.projects.length === 1) return ctx.config.projects[0]!;
  throw new CliError('NO_PROJECT', 'which project? Run in the project directory, or give --project <root>', { exitCode: EXIT.USAGE });
}

function withOptions(head: string, wi: string, extra: string[] = []): string {
  const t = wiTitle(wi);
  return [head, ...extra, `Handle per ${wi}${t !== null ? ` ${t}` : ''}: open the WI page ${wiPagePath(wi)}`].join('\n');
}

const list = (xs: readonly string[]): string => xs.join(', ');

/** The delivery result in the PM's words, with the WI where it is an exception. */
export function renderDelivery(r: DeliveryResult): { text: string; exitCode: number; wi: string | null } {
  switch (r.kind) {
    case 'delivered':
      return { text: `Delivery ref created: ${r.record.ref} (delivery commit ${r.record.commit}, base ${r.record.base}, ${r.record.rebuilds} rebuilds)`, exitCode: 0, wi: null };
    case 'incompatible':
      return { text: `The delivery manifest is incompatible (${r.conflicts.length} paths in different versions): an integration task is needed; the affected objects are re-accepted against the new version, then deliver again (6.6 step 2, a normal branch)`, exitCode: EXIT.REFUSED, wi: null };
    case 'conflict':
      return { text: `${r.conflicts.length} conflicts on base ${r.base}: an integration task resolves them and a Reviewer accepts it (6.6 step 3, a normal branch)`, exitCode: EXIT.REFUSED, wi: null };
    case 'unknown-targets':
      return { text: withOptions(`The manifest names objects the ledger does not know: ${list(r.missing.map((t) => t.id))}`, 'WI-20'), exitCode: EXIT.REFUSED, wi: 'WI-20' };
    case 'unplaced-products':
      return { text: withOptions(`These product versions have no commit placement and cannot be delivered: ${list(r.versions)}`, 'WI-20'), exitCode: EXIT.REFUSED, wi: 'WI-20' };
    case 'description-mismatch':
      return { text: withOptions(`These versions were accepted under another transform description and must be re-materialized and re-accepted: ${list(r.versions)}`, 'WI-19'), exitCode: EXIT.REFUSED, wi: 'WI-19' };
    case 'checks-failed':
      return { text: withOptions(`The closing checks failed on candidate ${r.commit} (${list(r.outcomes.filter((x) => !x.passed).map((x) => x.id))}): no delivery ref; the candidate and the failure evidence are kept`, 'WI-21'), exitCode: EXIT.REFUSED, wi: 'WI-21' };
    case 'objects-unavailable':
      return { text: withOptions(`Objects the candidate needs are missing locally (${r.code}): ${list([...r.objects, ...r.paths].slice(0, 10))}; nothing was fetched`, 'WI-13'), exitCode: EXIT.REFUSED, wi: 'WI-13' };
    case 'repository-unsupported':
      return { text: withOptions(`Unsupported repository format: ${r.detail}${r.extensions.length > 0 ? ` (extensions: ${list(r.extensions)})` : ''}. For a reftable repository ask the user to run git refs migrate --ref-format=files, then deliver again`, 'WI-13'), exitCode: EXIT.REFUSED, wi: 'WI-13' };
    case 'insufficient-space':
      return { text: withOptions(`Not enough space or inodes (${r.stage}): ${r.reasons.join('; ')}; deliver again after space is freed`, 'WI-10'), exitCode: EXIT.REFUSED, wi: 'WI-10' };
    case 'authorization-refused':
      return { text: `The ledger service refused the authorization: ${r.reason}. A stop in force or the recovery pause always refuses it (the safety floor); after the stop is released or going on is confirmed, run mp deliver again per the user's earlier "deliver"`, exitCode: EXIT.REFUSED, wi: null };
    case 'rebuild-limit-exhausted':
      return { text: withOptions(`This delivery's rebuilds are used up (${r.rebuilds})`, 'WI-08'), exitCode: EXIT.REFUSED, wi: 'WI-08' };
    case 'ref-tampered':
      return { text: withOptions(`The ref ${r.ref} in the program's namespace was changed from outside: not redone, completion not recorded`, 'WI-20'), exitCode: EXIT.REFUSED, wi: 'WI-20' };
    case 'ref-writer-running':
      return { text: withOptions(`The ref writer of an earlier attempt is still running (${list(r.processes.map((p) => String(p.pid)))}): this delivery stays to be verified`, 'WI-14'), exitCode: EXIT.REFUSED, wi: 'WI-14' };
    case 'ref-lock-held':
      return { text: withOptions(`The delivery ref's lock ${r.lock} is held by another process (the program cannot prove it is its own): it is not removed; this delivery stays to be verified and goes on once its owner is done`, 'WI-14'), exitCode: EXIT.REFUSED, wi: 'WI-14' };
    case 'ref-not-created':
      return { text: `The delivery ref ${r.ref} was not created (${r.detail}); the intent ended; run mp deliver again (it authorizes again)`, exitCode: EXIT.REFUSED, wi: null };
    default: {
      // a result kind added to the delivery module after this adapter: shown as it is, never as success
      const k = (r as { kind: string }).kind;
      return { text: withOptions(`The delivery did not complete (${k}): ${JSON.stringify(r).slice(0, 400)}`, 'WI-20'), exitCode: EXIT.REFUSED, wi: 'WI-20' };
    }
  }
}

/** The landing report in the PM's words, with its WI (WI-06 classes, WI-01/02/04/13/19). */
export function renderLanding(r: LandingReport, manual: readonly string[]): { text: string; exitCode: number; wi: string | null; landed: boolean } {
  if (r.kind === 'not-auto-landed') {
    const cmds = r.manualCommands.length > 0 ? r.manualCommands : manual;
    const extra = [`Reason: ${r.reason}: ${r.detail}`, ...(r.paths.length > 0 ? [`Paths: ${list(r.paths.slice(0, 10))}`] : []), ...(cmds.length > 0 ? ['Commands to merge by hand (the delivery ref is kept):', ...cmds.map((c) => `  ${c}`)] : [])];
    return { text: withOptions('Not landed automatically this time; nothing was written.', r.wi, extra), exitCode: EXIT.REFUSED, wi: r.wi, landed: false };
  }
  if (r.kind === 'push-unconfirmed') {
    return { text: withOptions(`The push process's result cannot be confirmed yet: ${r.detail}`, 'WI-06', [`Processes: ${list(r.processes.map((p) => String(p.pid)))}`]), exitCode: EXIT.REFUSED, wi: 'WI-06', landed: false };
  }
  const inconsistent = [...r.verification.worktrees.filter((w) => w.kind !== 'expected').map((w) => w.worktree), ...r.verification.newWorktrees.map((w) => w.path)];
  const reminders = r.reminders.map((x) => `Space reminder (does not block the landing, WI-10): ${x}`);
  switch (r.outcome) {
    case 'landed': {
      const lines = ['Landed: the target branch contains the delivery commit.', ...reminders];
      if (inconsistent.length > 0) lines.push(withOptions(`${inconsistent.length} worktrees are not as expected: ${list(inconsistent)}`, 'WI-04'));
      return { text: lines.join('\n'), exitCode: 0, wi: inconsistent.length > 0 ? 'WI-04' : null, landed: true };
    }
    case 'B':
      return { text: withOptions(`Not landed; the target branch is still the base; safe to retry (class B): ${r.why}`, 'WI-06', reminders), exitCode: EXIT.REFUSED, wi: 'WI-06', landed: false };
    case 'base-moved':
      return { text: withOptions(`Not landed: the target branch moved to a commit that does not contain the delivery commit (base moved); rebuild on the new base: ${r.why}`, 'WI-05', reminders), exitCode: EXIT.REFUSED, wi: 'WI-05', landed: false };
    case 'C':
      return { text: withOptions(`Not landed (class C: the push is never redone automatically): ${r.why}${r.locks.length > 0 ? `; leftover locks: ${list(r.locks)} (the program and the PM never delete them)` : ''}`, 'WI-06', reminders), exitCode: EXIT.REFUSED, wi: 'WI-06', landed: false };
  }
}

export function findRecorded(ctx: Ctx, delivery: string): DeliveryRecorded {
  const reader = Layer2Reader.open(ledgerPathsOf(ctx.config).db);
  if (reader === null) throw new CliError('UNAVAILABLE', 'cannot read the main ledger (read-only)', { exitCode: EXIT.UNAVAILABLE });
  try {
    const d = findDelivery(reader, delivery);
    if (d === null) throw new CliError('NOT_FOUND', `no delivery ${delivery} (a delivery is recorded once its ref is created)`, { exitCode: EXIT.REFUSED });
    return d.record;
  } finally {
    reader.close();
  }
}

async function landOnce(ctx: Ctx, rec: DeliveryRecorded, project: ProjectConfig, allowExternal: string | null, op: string): Promise<{ text: string; exitCode: number; json: unknown }> {
  const a = deliveryAdapter();
  const report = await a.land(ctx, { op, delivery: rec, project, allowExternal });
  const r = renderLanding(report, a.manualCommands(ctx, rec, project));
  return { text: r.text, exitCode: r.exitCode, json: { delivery: rec.delivery, landed: r.landed, wi: r.wi, report: deliveryJson(report) } };
}

export const deliverCmd: Command = {
  name: 'deliver',
  summary: 'deliver: compute the manifest, build the candidate, create the delivery ref, then land it (the user\'s "deliver" is consent to land)',
  usage: 'mp deliver <mission> --outputs <object,...|unit:<proof unit>> [--project <root>] [--no-land]',
  flags: { outputs: 'list', project: 'string', 'no-land': 'boolean' },
  changesState: true,
  async run(ctx, args, op): Promise<CommandResult> {
    const mission = missionArg(args, 0);
    const outputs = flagList(args, 'outputs');
    if (outputs.length === 0) throw usage('deliver needs --outputs (what the user wants delivered)');
    const project = resolveProject(ctx, flagStr(args, 'project'));
    const r = await deliveryAdapter().deliver(ctx, { op: op!, mission, outputs, project });
    const d = renderDelivery(r);
    if (r.kind !== 'delivered' || flagBool(args, 'no-land')) {
      const next = r.kind === 'delivered' ? `\nNext: mp land ${op}` : '';
      return ok(d.text + next, { delivery: op, result: deliveryJson(r), wi: d.wi }, d.exitCode);
    }
    // The record the delivery wrote (it carries the manifest and so the bound transform description).
    let rec: DeliveryRecorded;
    try {
      rec = findRecorded(ctx, op!);
    } catch {
      rec = { kind: 'delivery.recorded', mission, delivery: op!, commit: r.record.commit, base: r.record.base, ref: r.record.ref, manifest: '' };
    }
    const l = await landOnce(ctx, rec, project, null, op!);
    return ok(`${d.text}\n${l.text}`, { delivery: op, result: deliveryJson(r), landing: l.json }, l.exitCode);
  },
};

export const landCmd: Command = {
  name: 'land',
  summary: 'land a delivery (a new landing attempt); or deliver the ref only; or allow this one landing into an external worktree (WI-02)',
  usage: 'mp land <delivery> [--deliver-ref-only] [--allow-external <worktree>] [--project <root>]',
  flags: { 'deliver-ref-only': 'boolean', 'allow-external': 'string', project: 'string' },
  changesState: true,
  wi: 'WI-06',
  async run(ctx, args: ParsedArgs, op): Promise<CommandResult> {
    const delivery = positional(args, 0, "delivery (the delivery's operation id)");
    const refOnly = flagBool(args, 'deliver-ref-only');
    const allowExternal = flagStr(args, 'allow-external');
    if (refOnly && allowExternal !== null) throw usage('--deliver-ref-only and --allow-external cannot both be given');
    const project = resolveProject(ctx, flagStr(args, 'project'));
    const rec = findRecorded(ctx, delivery);
    if (refOnly) {
      const cmds = deliveryAdapter().manualCommands(ctx, rec, project);
      const text = [`Recorded: delivery ${delivery} is delivered as a ref only, no more automatic landing (layer 1 shows "delivered, not landed").`, `Delivery ref: ${rec.ref}`, 'The user or an agent merges:', ...cmds.map((c) => `  ${c}`)].join('\n');
      return ok(text, { delivery, refOnly: true, ref: rec.ref, manualCommands: cmds });
    }
    // Already landed (the target contains the delivery commit, 6.6 step 8): no new attempt.
    const state = await deliveryAdapter().landingState(ctx, rec);
    if (state.landed === true) return ok(`Delivery ${delivery} has landed (the target branch contains the delivery commit); nothing to land.`, { delivery, landed: true, refOnly: false, allowExternal, attempts: state.attempts });
    const l = await landOnce(ctx, rec, project, allowExternal, op!);
    return ok(l.text, { ...(l.json as object), refOnly: false, allowExternal }, l.exitCode);
  },
};

export const withdrawDeliveryCmd: Command = {
  name: 'withdraw-delivery',
  summary: 'the user withdrew a delivery: no landing or ref creation of it is authorized again (6.6)',
  usage: 'mp withdraw-delivery <delivery> --reason "<the user\'s words>"',
  flags: { reason: 'string' },
  changesState: true,
  async run(ctx, args, op) {
    const delivery = positional(args, 0, 'delivery');
    const reason = flagStr(args, 'reason');
    if (reason === null || reason.trim() === '') throw usage('--reason: the user\'s words withdrawing it');
    const rec = findRecorded(ctx, delivery);
    const r = (await ctx.call('withdrawDelivery', { op: op!, mission: rec.mission as never, delivery: rec.delivery, reason })) as { revision: number | null };
    return ok(r.revision === null ? `Delivery ${delivery} was already withdrawn.` : `Delivery ${delivery} withdrawn: it is never landed or delivered again. The delivery ref stays in the program's namespace.`, { delivery, withdrawn: true, revision: r.revision });
  },
};

export const detachDuplicateCmd: Command = {
  name: 'detach-duplicate',
  summary: 'WI-01 option 2: detach an abandoned duplicate checkout (HEAD at the same commit; index and files unchanged; nothing deleted)',
  usage: 'mp detach-duplicate <worktree> [--project <root>]',
  flags: { project: 'string' },
  changesState: true,
  wi: 'WI-01',
  async run(ctx, args) {
    const worktree = positional(args, 0, 'worktree');
    const project = resolveProject(ctx, flagStr(args, 'project'));
    const r = await deliveryAdapter().detachDuplicate(ctx, { worktree, project });
    if (r.kind === 'refused') return ok(`Nothing changed: ${r.reason}`, r, EXIT.REFUSED);
    return ok(`${r.worktree} is detached at ${r.commit} (no longer holding ${r.branch}); index and files unchanged, nothing deleted. Undo: ${r.undo}. With one occupant left the program lands by itself.`, r);
  },
};

export const closeCmd: Command = {
  name: 'close',
  summary: 'close a mission: with risk, full close-out, or post-audit (6.6); production stops, a closing snapshot is frozen',
  usage: 'mp close <mission> --mode with-risk|full|post-audit [--wait-running]',
  flags: { mode: 'string', 'wait-running': 'boolean' },
  changesState: true,
  async run(ctx, args, op) {
    const mission = missionArg(args, 0);
    const mode = flagStr(args, 'mode');
    if (mode === null || !['with-risk', 'full', 'post-audit'].includes(mode)) throw usage('--mode is with-risk, full or post-audit');
    const wait = flagBool(args, 'wait-running');
    const r = (await ctx.call('closeMission', { op: op!, mission: mission as never, mode: mode as 'with-risk' | 'full' | 'post-audit', waitRunning: wait })) as { version: number; asOf: number; unfinished: string };
    return ok(
      `Mission ${mission} closed (${mode}): closing snapshot version ${r.version} as of revision ${r.asOf}; ${wait ? 'running units finish first' : 'running production units are cancelled'}. Post-audits, deliveries and fixes can still start after closing.`,
      { mission, mode, ...r },
    );
  },
};
