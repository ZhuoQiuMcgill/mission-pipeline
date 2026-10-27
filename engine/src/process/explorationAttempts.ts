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
//
// The user's amendment of the method in force (design 4.3, 8.2): `mp pm amend-attempts`. A decision the
// user makes about a registered method (a scale, a cap, a search extended to more of the domain) is
// theirs, and they take responsibility for it: it is applied on their words, never sent for review.
// The file's attempts (the register's schema, checked as the author's registration is) add attempts
// or replace registered ones. One write records a new method version in force (the previous one's
// document, the register amended, and a section "Amended by the user's words W-<n>"), the user's pass
// on it (the position the attack decided for the previous version, its binding carried over: the
// interpretation relies on the version in force), and the event. No round is spent; no author,
// attacker or Stabilizer is dispatched. An added attempt runs, a replaced one runs under its new card
// (a record it had is superseded, kept as history; a run of its earlier card still waiting in the
// queue is withdrawn), and records of unchanged attempts keep counting. A repair about the
// exploration the amendment answers (`--answers`) no longer adds its round.

import { canonicalJson } from '../common/hash.ts';
import type { ContentHash, JudgmentId, MissionId, ObjectVersionId } from '../common/ids.ts';
import type { BaseRecord, JudgmentRecord, ObjectVersionRecord } from '../common/records.ts';
import { validateRecord } from '../common/validate.ts';
import { xid } from '../flow/exploration/definition.ts';
import {
  ATTEMPT_RERUN,
  ATTEMPTS_AMENDED,
  allowedRounds,
  attemptEvidence,
  attemptRecorded,
  fold,
  pendingTasks,
  type AttemptRerunBody,
  type AttemptsAmendedBody,
  type ConsumedBody,
  type XEvent,
  type XState,
} from '../flow/exploration/machine.ts';
import { explorationLine } from '../flow/plandoc.ts';
import type { DataStore } from '../memory/data.ts';
import { appendRecords, dequeueTask, factById, flowEvents, wordsEntry, type Db, type FlowEventRow } from '../memory/index.ts';
import { RegisteredAttempt, registerProblems, researchMethodDocument, type RegisteredAttemptT, type ResearchMethodDoc } from '../seat/cards/researcher.ts';
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
    const again = s.attemptReruns.get(a);
    if (again !== undefined && !attemptRecorded(s, a)) throw new ProcessError('ATTEMPT_QUEUED', `attempt ${a} of exploration ${x} is already to run again (${again.amendment !== undefined ? `under the card the user's amendment ${again.amendment} set` : `rerun ${again.n}`}): the next mp pm next queues its run`);
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

// ---------------------------------------------------------------- the user's amendment of the method in force

/** The file's attempts, each checked as the author's registration checks them (the register's schema and rules); unknown fields are refused, not dropped. */
function fileAttempts(raw: unknown): RegisteredAttemptT[] {
  if (!Array.isArray(raw)) throw new ProcessError('ATTEMPTS_INVALID', "the attempts file is a JSON array of attempt objects, in the schema of a method's registered attempts (id, kind, purpose, steps, data, measure, assertions, commands)");
  if (raw.length === 0) throw new ProcessError('ATTEMPTS_INVALID', 'the attempts file names no attempt: add or replace at least one');
  const known = new Set(Object.keys(RegisteredAttempt.shape));
  const out: RegisteredAttemptT[] = [];
  const problems: string[] = [];
  raw.forEach((a, i) => {
    const r = RegisteredAttempt.safeParse(a);
    if (!r.success) {
      problems.push(...r.error.issues.map((x) => `attempts[${i}]${x.path.length > 0 ? `.${x.path.map(String).join('.')}` : ''}: ${x.message}`));
      return;
    }
    const extra = typeof a === 'object' && a !== null ? Object.keys(a).filter((k) => !known.has(k)) : [];
    if (extra.length > 0) problems.push(`attempts[${i}] (${r.data.id}): unknown field(s) ${extra.join(', ')}`);
    out.push(r.data);
  });
  if (problems.length === 0) problems.push(...registerProblems(out));
  if (problems.length > 0) throw new ProcessError('ATTEMPTS_INVALID', `the attempts do not validate as the author's register would: ${problems.join('; ')}`);
  return out;
}

/** What an amendment writes: the new register, how each of the file's attempts counts, the steps it withdraws, the repair it answers. */
interface AmendPlan {
  readonly register: readonly RegisteredAttemptT[];
  readonly added: readonly string[];
  readonly replaced: readonly string[];
  readonly unchanged: readonly string[];
  readonly replaces: Readonly<Record<string, string>>;
  /** Waiting runs of replaced attempts, by attempt (each withdrawn), and the interpreter step withdrawn. */
  readonly runs: Readonly<Record<string, string>>;
  readonly interpreter: string | null;
  readonly answers: string | null;
}

/** The refusals the exploration's state decides (nothing is written), else what the amendment writes. */
function amendPlan(db: Db, data: DataStore, mission: string, x: string, file: readonly RegisteredAttemptT[], answers: string | null, s: XState): AmendPlan {
  if (s.defined === null || s.def === null) throw new ProcessError('NOT_ALLOWED', `mission ${mission} has no exploration ${x}`);
  if (s.settled !== null) {
    throw new ProcessError('EXPLORATION_SETTLED', `exploration ${x} of ${mission} is settled (${s.settled.body.outcome}): its result was handed on. To explore again with the user's decision, give the exploration a new id in the PM plan`);
  }
  if (s.stopped !== null) throw new ProcessError('EXPLORATION_STOPPED', `exploration ${x} of ${mission} is stopped (${s.stopped.reason}) and waits for the decision layer (mp pm next): run this again once it goes on`);
  if (s.abandoned !== null) throw new ProcessError('EXPLORATION_STOPPED', `a step of exploration ${x} of ${mission} was given up (${s.abandoned.task}): the decision layer decides first (mp pm next); run this again once it goes on`);
  if (!s.def.research) throw new ProcessError('NO_METHOD', `exploration ${x} of ${mission} is not a research exploration: it has no method and registers no attempts`);
  if (s.method === null) throw new ProcessError('NO_METHOD', `exploration ${x} of ${mission} has no method in force yet (its method is still being attacked): the user's decision reaches the author with a repair (mp pm repair --about ${x})`);
  if (s.phase === 'reasoning') {
    throw new ProcessError('INTERPRETATION_SUBMITTED', `exploration ${x} of ${mission} has an interpretation (${s.version?.id ?? '?'}) of the attempts' records already: the method is amended only before that. Ask the user how to go on (a repair, or a new exploration id in the PM plan)`);
  }
  // an interpreter that ran (or was dispatched) read the records: the method is no longer amended
  for (const q of s.tasks.values()) {
    if (q.role !== 'interpreter') continue;
    const c = s.consumed.get(q.task);
    if (c === undefined || c.kind === 'withdrawn') continue;
    if (c.kind === 'interpretation') throw new ProcessError('INTERPRETATION_SUBMITTED', `the interpreter of exploration ${x} handed back (step ${q.task}): its interpretation is submitted, and the method is amended only before that`);
    throw new ProcessError('INTERPRETER_DISPATCHED', `an interpreter of exploration ${x} was dispatched (step ${q.task}, ${c.kind}): it read the attempts' records, and the method is amended only before any interpreter is dispatched`);
  }
  let interpreter: string | null = null;
  for (const q of pendingTasks(s)) {
    if (q.role !== 'interpreter') continue;
    const st = taskStatus(db, data, q.task);
    if (st?.state === 'queued' && st.dispatches.length === 0) {
      interpreter = q.task;
      continue;
    }
    if (st?.state === 'queued') throw new ProcessError('INTERPRETER_DISPATCHED', `the interpreter step ${q.task} of exploration ${x} was dispatched before (${st.note ?? 'released'}): it read the attempts' records, and the method is amended only before any interpreter is dispatched`);
    if (st?.state === 'running') {
      throw new ProcessError('DISPATCH_IN_FLIGHT', `the interpreter of exploration ${x} is at work on the records (step ${q.task}, ${st.note ?? 'dispatched'}): the method is amended only before any interpreter is dispatched`);
    }
    if (st?.state === 'done' || st?.state === 'waiting-evidence') {
      throw new ProcessError('INTERPRETATION_SUBMITTED', `the interpreter of exploration ${x} handed back (step ${q.task}): its interpretation is submitted, and the method is amended only before that`);
    }
    throw new ProcessError('INTERPRETER_DISPATCHED', `the interpreter step ${q.task} of exploration ${x} is ${st?.state ?? 'unknown'}${st?.note ? ` (${st.note})` : ''}: it was dispatched, and the method is amended only before any interpreter is dispatched`);
  }
  // the file's attempts: new ids are added; a registered id whose object differs replaces that attempt
  const registered = new Map(s.method.attempts.map((a) => [a.id, a]));
  const byId = new Map(file.map((a) => [a.id, a]));
  const unchanged = file.filter((a) => registered.has(a.id) && canonicalJson(registered.get(a.id)) === canonicalJson(a)).map((a) => a.id);
  const register = [...s.method.attempts.map((a) => (byId.has(a.id) ? byId.get(a.id)! : a)), ...file.filter((a) => !registered.has(a.id))];
  const added = register.filter((a) => !registered.has(a.id)).map((a) => a.id);
  const replaced = register.filter((a) => registered.has(a.id) && byId.has(a.id) && !unchanged.includes(a.id)).map((a) => a.id);
  if (added.length === 0 && replaced.length === 0) {
    throw new ProcessError('NOTHING_AMENDED', `every attempt in the file equals its registered one in the method in force (${s.method.version}): ${unchanged.join(', ')}. Nothing is amended`);
  }
  // a replaced attempt's run of its earlier card: still waiting in the queue, it is withdrawn; one a seat has, refused
  const pending = pendingTasks(s);
  const replaces: Record<string, string> = {};
  const runs: Record<string, string> = {};
  for (const a of replaced) {
    for (const q of pending) {
      if (q.role !== 'executor' || q.evidence?.attempt !== a || q.evidence.requester !== null) continue;
      const st = taskStatus(db, data, q.task);
      if (st?.state === 'queued') {
        runs[a] = q.task;
        continue;
      }
      const where = st?.state === 'running' ? `in flight (${st.note ?? 'dispatched'})` : `handed back, not taken into account yet (${st?.state ?? 'unknown'}): run mp pm next first`;
      throw new ProcessError('ATTEMPT_QUEUED', `attempt ${a} of exploration ${x} has a run of its registered card ${where} (step ${q.task}): it is replaced only once that run's record is in, or its dispatch released`);
    }
    const rec = attemptEvidence(s, a);
    if (rec !== null) replaces[a] = rec;
  }
  let answered: string | null = null;
  if (answers !== null) {
    const open = s.repairs.filter((r) => !s.answeredRepairs.has(r.id)).map((r) => r.id);
    if (!s.repairs.some((r) => r.id === answers)) throw new ProcessError('REPAIR_NOT_OPEN', `no repair ${answers} is about exploration ${x}${open.length > 0 ? ` (open: ${open.join(', ')})` : ''}`);
    const by = s.answeredRepairs.get(answers);
    if (by !== undefined) throw new ProcessError('REPAIR_NOT_OPEN', `repair ${answers} is answered already, by the user's amendment ${by} of exploration ${x}`);
    // its round started: an author step queued after the repair was dispatched
    const since = s.repairSince.get(answers) ?? 0;
    for (const q of s.tasks.values()) {
      if (q.role !== 'author' || q.n <= since || s.consumed.get(q.task)?.kind === 'withdrawn') continue;
      const st = taskStatus(db, data, q.task);
      if (s.consumed.has(q.task) || st === null || st.state !== 'queued' || st.dispatches.length > 0) {
        throw new ProcessError('REPAIR_STARTED', `the round repair ${answers} added has started: the author step ${q.task} was dispatched for it. The amendment can still be applied without --answers`);
      }
    }
    answered = answers;
  }
  return { register, added, replaced, unchanged, replaces, runs, interpreter, answers: answered };
}

/** The section the amendment adds to the method's text: the user's words, the reason, what it added and replaced. */
function amendmentSection(words: string, reason: string | null, added: readonly string[], replaced: readonly string[], replaces: Readonly<Record<string, string>>): string {
  return [
    `## Amended by the user's words ${words}`,
    '',
    `Reason: ${reason !== null ? `"${reason}"` : 'none given'}`,
    `Added: ${added.length > 0 ? added.join(', ') : 'none'}`,
    `Replaced: ${replaced.length > 0 ? replaced.map((a) => (replaces[a] !== undefined ? `${a} (its record ${replaces[a]} superseded)` : a)).join(', ') : 'none'}`,
    '',
  ].join('\n');
}

/** What `mp pm amend-attempts` did. */
export interface AttemptsAmended {
  /** Its number on the exploration (1 for the first). */
  readonly n: number;
  /** The method version it amended, the one in force now, and the user's judgment that passes it. */
  readonly previous: string;
  readonly version: string;
  readonly judgment: string;
  /** The attempts added, each with the step of its run (null: not queued yet) and its record id. */
  readonly added: ReadonlyArray<{ readonly attempt: string; readonly step: string | null; readonly evidence: string | null }>;
  /** The attempts replaced: the record superseded (null: it had none), the waiting run of its earlier card withdrawn (or null), its new run. */
  readonly replaced: ReadonlyArray<{ readonly attempt: string; readonly replaces: string | null; readonly withdrawn: string | null; readonly step: string | null; readonly evidence: string | null }>;
  /** The file's attempts equal to their registered ones (their records keep counting). */
  readonly unchanged: readonly string[];
  /** The interpreter step withdrawn (it was queued on the earlier records), or null. */
  readonly withdrawn: string | null;
  /** The repair it answers (its added round taken back), or null. */
  readonly answers: string | null;
  /** The exploration's phase now ("attempts" until every attempt of the amended method has its record). */
  readonly phase: string;
  /** The round budget: no round spent; one an answered repair added is taken back. */
  readonly rounds: number;
  readonly allowedRounds: number;
}

/**
 * `mp pm amend-attempts <mission> <exploration> --words W-<n> --file <attempts.json> [--answers R-<n>] [--reason "<text>"]`:
 * the user's decision about a research exploration's method in force, applied on their words without a
 * round and without review. Accepted while the exploration is not settled or stopped, a method is in
 * force, and no interpreter was dispatched nor interpretation submitted (one still queued is withdrawn).
 * Refused (named, nothing written): NOT_ALLOWED, ATTEMPTS_INVALID, EXPLORATION_SETTLED,
 * EXPLORATION_STOPPED, NO_METHOD, INTERPRETATION_SUBMITTED, INTERPRETER_DISPATCHED, DISPATCH_IN_FLIGHT,
 * NOTHING_AMENDED, ATTEMPT_QUEUED, REPAIR_NOT_OPEN, REPAIR_STARTED.
 */
export async function pmAmendAttempts(
  ctx: ProcessContext,
  req: { readonly mission: string; readonly exploration: string; readonly attempts: unknown; readonly words: string; readonly reason?: string | null; readonly answers?: string | null },
): Promise<AttemptsAmended> {
  const mission = req.mission as MissionId;
  const x = req.exploration;
  const reason = req.reason === undefined || req.reason === null || req.reason.trim() === '' ? null : req.reason;
  const answers = req.answers === undefined || req.answers === null || req.answers.trim() === '' ? null : req.answers.trim();
  if (ctx.memory.read((db) => wordsEntry(db, req.words)) === null) throw new ProcessError('NOT_ALLOWED', `there is no words entry ${req.words} (mp pm say records one)`);
  const file = fileAttempts(req.attempts);
  const data = ctx.memory.data;
  const before = ctx.memory.read((db) => fold(eventsOf(db, data, mission, x)));
  // the state's refusals first; the write checks them again
  ctx.memory.read((db) => amendPlan(db, data, req.mission, x, file, answers, before));
  const n = ctx.memory.read((db) => rows(db, { mission, line: explorationLine(x) }).filter((e) => e.event === ATTEMPTS_AMENDED).length) + 1;
  const written = ctx.memory.write(
    { op: `amend-attempts:${req.mission}:${x}:${n}`, payload: { mission: req.mission, exploration: x, n, attempts: file, words: req.words, reason, answers }, command: 'amend-attempts', filler: ctx.filler },
    (tx) => {
      const events0 = eventsOf(tx, tx.data, mission, x);
      if (events0.filter((e) => e.event === ATTEMPTS_AMENDED).length + 1 !== n) throw new ProcessError('NOT_READY', `another amendment of exploration ${x}'s method was recorded meanwhile: run this again`);
      const s = fold(events0);
      const p = amendPlan(tx, tx.data, req.mission, x, file, answers, s);
      const method = s.method!;
      const def = s.def!;
      // the previous version's document, its object version and the pass that decides its position
      const prev = s.versions.find((v) => v.id === method.version);
      const prevObj = factById(tx, 'object.version', method.version)?.record as ObjectVersionRecord | undefined;
      const pass = method.judgment !== undefined ? (factById(tx, 'judgment', method.judgment)?.record as JudgmentRecord | undefined) : undefined;
      if (prev === undefined || prevObj === undefined || pass === undefined || pass.verdict !== 'pass' || pass.target !== method.version) {
        throw new ProcessError('NOT_READY', `the method in force of exploration ${x} (${method.version}) has no recorded pass to carry over: run mp pm next first, then this again`);
      }
      const prevDoc = JSON.parse(tx.data.text(prev.content)) as ResearchMethodDoc;
      const text = `${prevDoc.method.trimEnd()}\n\n${amendmentSection(req.words, reason, p.added, p.replaced, p.replaces)}`;
      const content = tx.data.put(researchMethodDocument(def.exploration, text, p.register)) as ContentHash;
      const version = `${xid.amendPrefix(req.mission, def.exploration, n)}.${content.slice(0, 16)}` as ObjectVersionId;
      // the new method version: the previous one's object with the amended content, its successor
      const obj: ObjectVersionRecord = { ...prevObj, object: version, content, predecessor: method.version as ObjectVersionId };
      validateRecord(obj);
      // the user's pass on it: the user decided it and takes responsibility (no review); its binding is
      // the previous version's deciding pass, carried over, so it stands no better than that one
      const judgment: JudgmentRecord = {
        kind: 'judgment',
        judgment: xid.amendJudgment(req.mission, def.exploration, n) as JudgmentId,
        review: pass.review,
        executor: 'user',
        target: version,
        verdict: 'pass',
        evidence: pass.evidence,
        bases: pass.bases,
        constraints: pass.constraints,
        reliesOn: pass.reliesOn,
        issues: [],
        revokes: null,
        evidenceUse: pass.evidenceUse,
        superseded: [],
        extends: null,
      };
      validateRecord(judgment);
      const withdrawn = [...p.replaced.flatMap((a) => (p.runs[a] !== undefined ? [p.runs[a]!] : [])), ...(p.interpreter !== null ? [p.interpreter] : [])];
      const body: AttemptsAmendedBody = {
        n,
        previous: method.version,
        version,
        content,
        judgment: judgment.judgment,
        attempts: p.register,
        added: p.added,
        replaced: p.replaced,
        replaces: p.replaces,
        withdrawn,
        words: req.words,
        reason,
        answers: p.answers,
        by: 'pm',
      };
      const line = explorationLine(x);
      const put = (b: unknown): ContentHash => tx.data.put(canonicalJson(b)) as ContentHash;
      const records: BaseRecord[] = [obj, judgment, { kind: 'flow.event', mission, line, event: ATTEMPTS_AMENDED, key: String(n), body: put(body) }];
      for (const t of withdrawn) {
        const q = s.tasks.get(t)!;
        const why = q.role === 'interpreter' ? 'the interpretation waits for the records of the amended method' : `attempt ${q.evidence?.attempt ?? '?'} runs under its new card`;
        const c: ConsumedBody = { kind: 'withdrawn', task: t, role: q.role, reason: `the method amended on the user's words ${req.words} (mp pm amend-attempts ${n}): ${why}` };
        records.push({ kind: 'flow.event', mission, line, event: 'consumed', key: t, body: put(c) });
      }
      appendRecords(tx, records);
      for (const t of withdrawn) dequeueTask(tx, { task: t, reason: 'cancelled' });
      return { p, version, judgment: judgment.judgment, previous: method.version, since: s.evidenceSeq };
    },
  );
  await advance(ctx, mission, { dispatch: null, task: null, step: `mp pm amend-attempts ${req.mission} ${x} --words ${req.words}` });
  const after = ctx.memory.read((db) => fold(eventsOf(db, data, mission, x)));
  const runOf = (a: string): { readonly step: string | null; readonly evidence: string | null } => {
    const run = [...after.tasks.values()].find((q) => q.evidence?.attempt === a && q.evidence.requester === null && q.evidence.k > written.since);
    return { step: run?.task ?? null, evidence: run?.evidence?.id ?? null };
  };
  const p = written.p;
  return {
    n,
    previous: written.previous,
    version: written.version,
    judgment: written.judgment,
    added: p.added.map((a) => ({ attempt: a, ...runOf(a) })),
    replaced: p.replaced.map((a) => ({ attempt: a, replaces: p.replaces[a] ?? null, withdrawn: p.runs[a] ?? null, ...runOf(a) })),
    unchanged: p.unchanged,
    withdrawn: p.interpreter,
    answers: p.answers,
    phase: after.phase,
    rounds: after.rounds,
    allowedRounds: allowedRounds(after),
  };
}
