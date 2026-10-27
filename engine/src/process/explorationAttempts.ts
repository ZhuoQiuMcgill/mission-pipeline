// Registered attempts of a research exploration run again on the same method version (design 4.3,
// 8.2): `mp pm rerun-attempt`. An attempt's blind run can fail for a cause outside the method (the
// platform's time limit, since raised); its record then answers nothing about the question. On the
// PM's word each named attempt gets a fresh blind run of its registered card (the same steps and
// commands; constraints selected at queue time and at the claim, as for every card), in the
// register's order. Its new record supersedes the earlier one for every reader (machine.ts
// attemptRecorded, attemptEvidence, supersededAttemptRecord); the earlier one stays in the memory as
// history. No round is spent: until an interpretation is submitted only the interpreter reads the
// attempts' records, and it counts no round. An interpreter step queued on the earlier records is
// withdrawn in the same write, and the exploration goes back to its attempts until the new records
// are in; one in flight, or an interpretation submitted, is refused.

import { canonicalJson } from '../common/hash.ts';
import type { ContentHash, MissionId } from '../common/ids.ts';
import { ATTEMPT_RERUN, allowedRounds, attemptEvidence, attemptRecorded, fold, pendingTasks, type AttemptRerunBody, type ConsumedBody, type XEvent, type XState } from '../flow/exploration/machine.ts';
import { explorationLine } from '../flow/plandoc.ts';
import type { DataStore } from '../memory/data.ts';
import { appendRecords, dequeueTask, flowEvents, wordsEntry, type Db, type FlowEventRow } from '../memory/index.ts';
import { advance } from './advance.ts';
import type { ProcessContext } from './context.ts';
import { ProcessError } from './errors.ts';
import { taskStatus } from './ports.ts';

function rows(db: Db, q: { readonly mission: MissionId; readonly line: string }): FlowEventRow[] {
  const out: FlowEventRow[] = [];
  for (let after = 0; ; ) {
    const page = flowEvents(db, { ...q, after, limit: 1000 });
    if (page.length === 0) return out;
    out.push(...page);
    after = Number(page.at(-1)!.revision);
  }
}

/** The exploration's events as the machine folds them, read in this transaction. */
function eventsOf(db: Db, data: DataStore, mission: MissionId, x: string): XEvent[] {
  return rows(db, { mission, line: explorationLine(x) }).map((e) => ({ event: e.event, key: e.key, body: JSON.parse(data.text(e.body)) as unknown }));
}

/** What a rerun of the named attempts writes: the attempts in the register's order, the records they supersede, the interpreter step it withdraws. */
interface RerunPlan {
  readonly attempts: readonly string[];
  readonly replaces: Readonly<Record<string, string>>;
  readonly withdraw: string | null;
}

/** The refusals the exploration's state decides (nothing is written), else what the rerun writes. */
function plan(db: Db, data: DataStore, mission: string, x: string, named: readonly string[], s: XState): RerunPlan {
  if (s.defined === null || s.def === null) throw new ProcessError('NOT_ALLOWED', `mission ${mission} has no exploration ${x}`);
  if (s.settled !== null) {
    throw new ProcessError('EXPLORATION_SETTLED', `exploration ${x} of ${mission} is settled (${s.settled.body.outcome}): its result was handed on. After an environment change, mp pm reopen-exploration ${mission} ${x} runs its evidence again; to explore again, give the exploration a new id in the PM plan`);
  }
  if (s.stopped !== null) throw new ProcessError('EXPLORATION_STOPPED', `exploration ${x} of ${mission} is stopped (${s.stopped.reason}) and waits for the decision layer (mp pm next): run this again once it goes on`);
  if (!s.def.research) throw new ProcessError('ATTEMPT_NOT_REGISTERED', `exploration ${x} of ${mission} is not a research exploration: it registers no attempts`);
  if (s.method === null) throw new ProcessError('ATTEMPT_NOT_REGISTERED', `exploration ${x} of ${mission} has no method in effect yet (its method is still being attacked): no attempt is registered`);
  if (s.phase === 'reasoning') {
    throw new ProcessError('INTERPRETATION_SUBMITTED', `exploration ${x} of ${mission} has an interpretation (${s.version?.id ?? '?'}) of the attempts' records already: a rerun applies only before the interpretation is submitted. Ask the user how to go on (a new exploration id in the PM plan explores again)`);
  }
  const registered = s.method.attempts.map((a) => a.id);
  const unknown = named.filter((a) => !registered.includes(a));
  if (unknown.length > 0) throw new ProcessError('ATTEMPT_NOT_REGISTERED', `the method in effect of exploration ${x} (${s.method.version}) registers ${registered.join(', ')}; not ${unknown.join(', ')}`);
  const attempts = registered.filter((a) => named.includes(a));
  const pending = pendingTasks(s);
  const replaces: Record<string, string> = {};
  for (const a of attempts) {
    const run = pending.find((q) => q.role === 'executor' && q.evidence?.attempt === a && q.evidence.requester === null);
    const st = run === undefined ? null : taskStatus(db, data, run.task);
    const where = run === undefined ? '' : `step ${run.task}, ${st?.state === 'running' ? `in flight (${st.note ?? 'dispatched'})` : st?.state === 'queued' ? 'queued' : `handed back, not taken into account yet (${st?.state ?? 'unknown'})`}`;
    const rec = attemptEvidence(s, a);
    if (rec === null) throw new ProcessError('ATTEMPT_NO_EVIDENCE', `attempt ${a} of exploration ${x} has no record yet${where !== '' ? ` (its run: ${where})` : ''}: there is nothing to run again; it runs as registered`);
    if (run !== undefined) throw new ProcessError('ATTEMPT_QUEUED', `attempt ${a} of exploration ${x} has a run of it already (${where}): its record is the one that counts; run this again only once it is in`);
    if (s.attemptReruns.has(a) && !attemptRecorded(s, a)) throw new ProcessError('ATTEMPT_QUEUED', `attempt ${a} of exploration ${x} is already to run again (rerun ${s.attemptReruns.get(a)!.n}): the next mp pm next queues its run`);
    replaces[a] = rec;
  }
  // an interpreter step queued on the earlier records is withdrawn; one at work, or handed back, is not
  let withdraw: string | null = null;
  for (const q of pending) {
    if (q.role !== 'interpreter') continue;
    const st = taskStatus(db, data, q.task);
    if (st?.state === 'queued') {
      withdraw = q.task;
      continue;
    }
    if (st?.state === 'running') {
      throw new ProcessError('DISPATCH_IN_FLIGHT', `the interpreter of exploration ${x} is at work on the earlier records (step ${q.task}, ${st.note ?? 'dispatched'}): wait for its hand-back (the interpretation is then submitted, and this no longer applies), or release it (mp pm release <dispatch> --ended) and run this again`);
    }
    if (st?.state === 'done' || st?.state === 'waiting-evidence') {
      throw new ProcessError('INTERPRETATION_SUBMITTED', `the interpreter of exploration ${x} handed back (step ${q.task}): its interpretation is submitted, and a rerun applies only before that. Ask the user how to go on (a new exploration id in the PM plan explores again)`);
    }
    throw new ProcessError('NOT_READY', `the interpreter step ${q.task} of exploration ${x} is ${st?.state ?? 'unknown'}${st?.note ? ` (${st.note})` : ''}: run mp pm next first, then this again`);
  }
  return { attempts, replaces, withdraw };
}

/** What `mp pm rerun-attempt` did. */
export interface AttemptsRerun {
  /** Its number on the exploration (1 for the first). */
  readonly n: number;
  /** The attempts run again, in the register's order, with the record each supersedes and the step of its new run (null: not queued yet). */
  readonly attempts: ReadonlyArray<{ readonly attempt: string; readonly replaces: string; readonly step: string | null; readonly evidence: string | null }>;
  /** The interpreter step withdrawn (it was queued on the earlier records), or null. */
  readonly withdrawn: string | null;
  /** The exploration's phase now ("attempts" until the new records are in). */
  readonly phase: string;
  /** The round budget, unchanged: no round is spent. */
  readonly rounds: number;
  readonly allowedRounds: number;
}

/**
 * `mp pm rerun-attempt <mission> <exploration> <attempt>[,<attempt>...] --words W-<n> [--reason "<text>"]`:
 * the PM's word that registered attempts of a research exploration run again on the same method
 * version, without a round. Accepted while the exploration is not settled or stopped, its method in
 * effect registers each attempt, each has its record and no run of it is queued or in flight, and no
 * interpretation is submitted (an interpreter step still queued is withdrawn). Refused (named, nothing
 * written): NOT_ALLOWED, EXPLORATION_SETTLED, EXPLORATION_STOPPED, ATTEMPT_NOT_REGISTERED,
 * ATTEMPT_NO_EVIDENCE, ATTEMPT_QUEUED, INTERPRETATION_SUBMITTED, DISPATCH_IN_FLIGHT.
 */
export async function pmRerunAttempt(ctx: ProcessContext, req: { readonly mission: string; readonly exploration: string; readonly attempts: readonly string[]; readonly words: string; readonly reason?: string | null }): Promise<AttemptsRerun> {
  const mission = req.mission as MissionId;
  const x = req.exploration;
  const named = [...new Set(req.attempts.map((a) => a.trim()).filter((a) => a !== ''))];
  if (named.length === 0) throw new ProcessError('NOT_ALLOWED', 'name at least one registered attempt to run again');
  const reason = req.reason === undefined || req.reason === null || req.reason.trim() === '' ? null : req.reason;
  if (ctx.memory.read((db) => wordsEntry(db, req.words)) === null) throw new ProcessError('NOT_ALLOWED', `there is no words entry ${req.words} (mp pm say records one)`);
  const data = ctx.memory.data;
  const before = ctx.memory.read((db) => fold(eventsOf(db, data, mission, x)));
  // the state's refusals first; the write checks them again
  const first = ctx.memory.read((db) => plan(db, data, req.mission, x, named, before));
  const n = ctx.memory.read((db) => rows(db, { mission, line: explorationLine(x) }).filter((e) => e.event === ATTEMPT_RERUN).length) + 1;
  const written = ctx.memory.write(
    { op: `rerun-attempt:${req.mission}:${x}:${n}`, payload: { mission: req.mission, exploration: x, n, attempts: first.attempts, words: req.words, reason }, command: 'rerun-attempt', filler: ctx.filler },
    (tx) => {
      const events0 = eventsOf(tx, tx.data, mission, x);
      if (events0.filter((e) => e.event === ATTEMPT_RERUN).length + 1 !== n) throw new ProcessError('NOT_READY', `another rerun of exploration ${x}'s attempts was recorded meanwhile: run this again`);
      const s = fold(events0);
      const p = plan(tx, tx.data, req.mission, x, named, s);
      const body: AttemptRerunBody = { n, attempts: p.attempts, replaces: p.replaces, words: req.words, reason, withdrawn: p.withdraw, by: 'pm' };
      const line = explorationLine(x);
      const put = (b: unknown): ContentHash => tx.data.put(canonicalJson(b)) as ContentHash;
      const events = [{ kind: 'flow.event' as const, mission, line, event: ATTEMPT_RERUN, key: String(n), body: put(body) }];
      if (p.withdraw !== null) {
        const q = s.tasks.get(p.withdraw)!;
        const c: ConsumedBody = { kind: 'withdrawn', task: p.withdraw, role: q.role, reason: `attempt(s) ${p.attempts.join(', ')} run again (mp pm rerun-attempt ${n}): the interpretation waits for their new records` };
        events.push({ kind: 'flow.event', mission, line, event: 'consumed', key: p.withdraw, body: put(c) });
      }
      appendRecords(tx, events);
      if (p.withdraw !== null) dequeueTask(tx, { task: p.withdraw, reason: 'cancelled' });
      return p;
    },
  );
  await advance(ctx, mission, { dispatch: null, task: null, step: `mp pm rerun-attempt ${req.mission} ${x} ${written.attempts.join(',')}` });
  const after = ctx.memory.read((db) => fold(eventsOf(db, data, mission, x)));
  const since = after.attemptReruns;
  return {
    n,
    attempts: written.attempts.map((a) => {
      const run = [...after.tasks.values()].find((q) => q.evidence?.attempt === a && q.evidence.requester === null && q.evidence.k > (since.get(a)?.since ?? 0));
      return { attempt: a, replaces: written.replaces[a]!, step: run?.task ?? null, evidence: run?.evidence?.id ?? null };
    }),
    withdrawn: written.withdraw,
    phase: after.phase,
    rounds: after.rounds,
    allowedRounds: allowedRounds(after),
  };
}
