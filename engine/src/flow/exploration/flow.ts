// The exploration flow's driver (design 4.3, 6.2, 8.2, 3.11): reads the exploration's events,
// takes finished seat tasks into account, and takes the next step. Every step has a fixed
// identity (task ids and op ids derive from the exploration id and the step number), and the
// card of a step is built from the folded state alone, so a driver restarted at any point
// repeats nothing and loses nothing: submitting a task again is a no-op, appending an op again
// is a no-op, and notices are idempotent by (category, key).
//
// Order of effects (crash safety): a task is submitted before its "queued" event is appended (a
// crash in between re-decides the same task); a notice is sent before the event that makes it
// unnecessary to send again (a crash in between sends the same notice again: a no-op).

import { canonicalJson } from '../../common/hash.ts';
import type { MissionId } from '../../common/ids.ts';
import type { BaseRecord, EnvSnapshotRecord, EvidenceRecord, PlainBasisVersionRecord, RunLayerRecord } from '../../common/records.ts';
import { attackOutcome, crititorFindingDocument, crititorFindingIds, versionId, type CrititorCard, type CrititorResult } from '../../seat/cards/crititor.ts';
import { blindEvidenceRecord, blindReportDocument, failedEvidenceRecord, type BlindResult, type ExperimentCard } from '../../seat/cards/experiment.ts';
import {
  authorSubmittedVersion,
  interpretationDocument,
  interpretationHasNoConclusion,
  type AuthorCard,
  type AuthorResult,
  type InterpreterCard,
  type InterpreterResult,
  type ReaderCard,
} from '../../seat/cards/researcher.ts';
import type { AnyCard, FlowLedgerPort, FlowNotice, FlowSchedulerPort, FlowTask, FlowTaskStatus } from '../ports.ts';
import { attackerCard, authorCard, executorCard, interpreterCard, parseEvidenceRequest, type EvidenceRequestDoc, type Resume } from './cards.ts';
import { ExplorationDefinitionSchema, xid, type ExplorationDefinition } from './definition.ts';
import {
  allowedRounds,
  decide,
  fold,
  pendingTasks,
  type Action,
  type ConsumedBody,
  type DefinedBody,
  type Disposition,
  type QueuedBody,
  type Role,
  type RulingBody,
  type StopReason,
  type StoppedBody,
  type XState,
} from './machine.ts';

export interface ExplorationPorts {
  readonly ledger: FlowLedgerPort;
  readonly scheduler: FlowSchedulerPort;
}

/**
 * What to do with a seat task that ended without a usable hand-back (needs disposition,
 * exhausted): the flow engine's step hands it to the Secretary (src/flow/failures.ts, WI-15 and
 * WI-08); without a hook the exploration simply waits at that task (the scheduler raised the WI).
 */
export type FailedTaskHook = (q: QueuedBody, st: FlowTaskStatus) => Promise<void>;

const DEFINED = 'defined';

function line(x: string): string {
  return xid.line(x);
}

async function load(p: ExplorationPorts, mission: MissionId, x: string): Promise<XState> {
  const events = await p.ledger.events({ mission, line: line(x) });
  return fold(events.map((e) => ({ event: e.event, key: e.key, body: e.body })));
}

// ---------------------------------------------------------------- define

/**
 * Define an exploration (the decision layer's call, 4.3): the definition becomes a basis line
 * (its version is what every attack judgment binds, 10.1 "Crititor 攻击与裁决"), the evidence
 * environment line is registered (7.2: the exploration's evidence stays applicable while it is
 * current), and the snapshot the seats read is fixed. Idempotent; a different definition under
 * the same id is refused (FACT_CONFLICT).
 */
export async function defineExploration(p: ExplorationPorts, input: ExplorationDefinition): Promise<void> {
  const def = ExplorationDefinitionSchema.parse(input);
  const mission = def.mission as MissionId;
  const existing = await p.ledger.events({ mission, line: line(def.exploration), event: DEFINED });
  if (existing.length > 0) {
    if (canonicalJson((existing[0]?.body as DefinedBody).definition) !== canonicalJson(def)) throw new Error(`exploration ${def.exploration} is already defined differently (use redefineExploration)`);
    return;
  }
  const snapshot = await p.scheduler.snapshot({ mission, purpose: `exploration-${def.exploration}` });
  const definitionDoc = p.ledger.content.put(canonicalJson(def));
  const body: DefinedBody = {
    definition: def,
    definitionDoc,
    basisLine: xid.basisLine(def.mission, def.exploration),
    basisVersion: xid.basisVersion(def.mission, def.exploration, 1),
    envLine: xid.envLine(def.mission, def.exploration),
    envSnapshot: xid.envSnapshot(def.mission, def.exploration, p.ledger.content.put(canonicalJson({ snapshot: snapshot.commit, mission: def.mission, exploration: def.exploration }))),
    snapshot: { path: snapshot.path, commit: snapshot.commit },
  };
  const basis: PlainBasisVersionRecord = { kind: 'basis.version', basisKind: 'standard', line: body.basisLine as never, version: body.basisVersion as never, mission, scope: null };
  const env: EnvSnapshotRecord = { kind: 'env.snapshot', line: body.envLine as never, snapshot: body.envSnapshot as never };
  await p.ledger.append(xid.op(def.mission, def.exploration, 'define'), { events: [{ mission, line: line(def.exploration), event: DEFINED, key: 'definition', body }], records: [basis, env] });
}

/**
 * A changed definition of a defined exploration (the PM plan revised its goal, scope, budget...):
 * a new version of its basis line, so every judgment bound to the old version stops being current
 * (5.2) and the current version is attacked again under the new definition. Idempotent; returns
 * false when nothing changed. A settled exploration is not redefined (its result was handed on):
 * the caller defines a new exploration instead.
 */
export async function redefineExploration(p: ExplorationPorts, input: ExplorationDefinition): Promise<boolean> {
  const def = ExplorationDefinitionSchema.parse(input);
  const mission = def.mission as MissionId;
  const s = await load(p, mission, def.exploration);
  if (s.def === null || s.defined === null) throw new Error(`exploration ${def.exploration} is not defined`);
  if (canonicalJson(s.def) === canonicalJson(def)) return false;
  const v = Number(s.defined.basisVersion.slice(s.defined.basisVersion.lastIndexOf('.v') + 2)) + 1;
  const basisVersion = xid.basisVersion(def.mission, def.exploration, v);
  const definitionDoc = p.ledger.content.put(canonicalJson(def));
  const basis: PlainBasisVersionRecord = { kind: 'basis.version', basisKind: 'standard', line: s.defined.basisLine as never, version: basisVersion as never, mission, scope: null };
  await p.ledger.append(xid.op(def.mission, def.exploration, `redefine:${v}`), { events: [{ mission, line: line(def.exploration), event: 'redefined', key: String(v), body: { definition: def, definitionDoc, basisVersion } }], records: [basis] });
  return true;
}

// ---------------------------------------------------------------- rulings

/**
 * A ruling of the decision layer (3.8 Secretary, 3.2 user): accept findings as residual risks,
 * redirect them, extend the budget (WI-08), retry a given-up turn (WI-15), stop, or answer a
 * direction question. Idempotent by ruling id.
 */
export async function recordExplorationRuling(p: ExplorationPorts, mission: MissionId, x: string, r: RulingBody): Promise<void> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,100}$/.test(r.id)) throw new Error(`bad ruling id ${JSON.stringify(r.id)}`);
  await p.ledger.append(xid.op(mission, x, `ruling:${r.id}`), { events: [{ mission, line: line(x), event: 'ruling', key: r.id, body: r }] });
}

// ---------------------------------------------------------------- advance

export interface AdvanceReport {
  readonly exploration: string;
  /** Steps taken in this call (consumptions, submissions, stops). */
  readonly steps: number;
  readonly state: 'running' | 'waiting' | 'stopped' | 'undefined';
  readonly why: string;
  readonly rounds: number;
  readonly version: string | null;
  readonly stopped: StoppedBody | null;
}

/** Take every step that can be taken now (bounded), then report. */
export async function advanceExploration(p: ExplorationPorts, mission: MissionId, x: string, maxSteps = 64, onFailed?: FailedTaskHook): Promise<AdvanceReport> {
  let steps = 0;
  for (;;) {
    const s = await load(p, mission, x);
    if (s.def === null) return report(x, s, steps, 'undefined', 'not defined');
    if (steps >= maxSteps) return report(x, s, steps, 'running', 'step budget of this call used; call again');
    if (await consumeFinished(p, mission, x, s, onFailed)) {
      steps++;
      continue;
    }
    const a = decide(s, { spentMicros: s.def.budget.spendMicros !== null ? await spentMicros(p, s) : null });
    if (a.kind === 'none') return report(x, s, steps, s.stopped !== null ? 'stopped' : 'waiting', a.why);
    await perform(p, mission, x, s, a);
    steps++;
  }
}

function report(x: string, s: XState, steps: number, state: AdvanceReport['state'], why: string): AdvanceReport {
  return { exploration: x, steps, state, why, rounds: s.rounds, version: s.version?.id ?? null, stopped: s.stopped };
}

/** Advance every exploration with events in these missions (the engine's reconcile pass). */
export async function advanceAllExplorations(p: ExplorationPorts, missions?: readonly MissionId[]): Promise<AdvanceReport[]> {
  const out: AdvanceReport[] = [];
  for (const m of missions ?? (await p.ledger.missions())) {
    const defs = await p.ledger.events<DefinedBody>({ mission: m, event: DEFINED });
    for (const d of defs) if (d.line.startsWith('exploration:')) out.push(await advanceExploration(p, m, d.line.slice('exploration:'.length)));
  }
  return out;
}

/**
 * What the exploration's launches spent so far (6.5): settled requests at their actual cost, open
 * reservations at their reserved upper bound. Read from the ledger's spend records.
 */
async function spentMicros(p: ExplorationPorts, s: XState): Promise<number> {
  const launches = new Set<string>();
  for (const q of s.tasks.values()) for (const l of (await p.scheduler.status(q.task))?.launches ?? []) launches.add(l);
  if (launches.size === 0) return 0;
  const reserved = new Map<string, number>();
  for (const c of await p.ledger.records(['spend.reserve'])) if (launches.has(c.record.launch)) reserved.set(c.record.reservation, c.record.micros);
  let total = 0;
  const settled = new Set<string>();
  for (const c of await p.ledger.records(['spend.settle'])) {
    if (!reserved.has(c.record.reservation)) continue;
    settled.add(c.record.reservation);
    total += c.record.micros;
  }
  for (const [r, m] of reserved) if (!settled.has(r)) total += m;
  return total;
}

// ---------------------------------------------------------------- consuming finished tasks

function cardOf<C>(p: ExplorationPorts, q: QueuedBody): C {
  return JSON.parse(p.ledger.content.get(q.card)) as C;
}

/** Take the first finished task into account; true when something was appended. */
async function consumeFinished(p: ExplorationPorts, mission: MissionId, x: string, s: XState, onFailed?: FailedTaskHook): Promise<boolean> {
  for (const q of pendingTasks(s).sort((a, b) => a.n - b.n)) {
    const st = await p.scheduler.status(q.task);
    if (st === null) {
      // the scheduler lost the task (not in its queue): submit the same card again
      await p.scheduler.submit(taskOf(s, q.task, q.lineage, cardOf<AnyCard>(p, q)));
      continue;
    }
    if (onFailed !== undefined && (st.state === 'needs-disposition' || st.state === 'exhausted' || (st.state === 'done' && st.handBack?.status !== 'handed-back'))) {
      await onFailed(q, st);
      continue;
    }
    const body = consumption(p, s, q, st);
    if (body === null) continue;
    const records: BaseRecord[] = [];
    if (body.kind === 'evidence' && !body.auto && q.role === 'executor' && st.handBack !== null) {
      const card = cardOf<ExperimentCard | ReaderCard>(p, q);
      // the experiment's evidence record is the program's (the hand-back made none)
      if (!st.handBack.records.some((x) => x.kind === 'evidence' && x.evidence === card.evidence.id)) records.push(blindRecordOf(p, card, st.handBack.result as BlindResult, st.handBack));
    }
    if (body.kind === 'evidence' && body.auto && q.evidence !== null) {
      records.push(failedEvidenceRecord({ id: q.evidence.id, envLine: (s.defined as DefinedBody).envLine, envSnapshot: (s.defined as DefinedBody).envSnapshot, attempt: q.evidence.attempt }, 'failed', st.note ?? 'given up', q.evidence.executor));
    }
    await notifyConsumption(p, mission, x, s, q, body);
    await p.ledger.append(xid.op(mission, x, `consume:${q.task}`), { events: [{ mission, line: line(x), event: 'consumed', key: q.task, body }], records });
    return true;
  }
  return false;
}

function dispositions(ds: AuthorResult['dispositions']): Disposition[] {
  return ds.map((d) => ({ finding: d.finding, action: d.action, note: d.note, evidence: d.evidence ?? null, question: d.question ?? null }));
}

/** The flow's reading of a finished task, or null while it is not finished. */
function consumption(p: ExplorationPorts, s: XState, q: QueuedBody, st: FlowTaskStatus): ConsumedBody | null {
  if (st.state === 'abandoned') {
    if (q.role === 'executor') return { kind: 'evidence', task: q.task, evidence: q.evidence?.id ?? '', status: 'failed', summary: `the run was given up: ${st.note ?? 'no reason recorded'}`, report: null, attempt: q.evidence?.attempt ?? null, auto: true };
    return { kind: 'abandoned', task: q.task, role: q.role, reason: st.note ?? 'given up' };
  }
  const hb = st.handBack;
  if (hb === null) return null;
  if (st.state === 'waiting-evidence' || hb.status === 'needs-evidence') {
    return { kind: 'needs-evidence', task: q.task, role: q.role, request: hb.evidenceRequest, recoveryState: hb.recoveryState, sessionId: hb.sessionId };
  }
  if (st.state !== 'done' || hb.status !== 'handed-back') return null;
  const put = (d: string): string => p.ledger.content.put(d);
  switch (q.role) {
    case 'author': {
      const card = cardOf<AuthorCard>(p, q);
      const r = hb.result as AuthorResult;
      const v = authorSubmittedVersion(card, r, put);
      return {
        kind: 'author',
        task: q.task,
        step: r.step,
        message: r.message,
        version: r.step === 'submit' ? (v?.version ?? null) : null,
        content: r.step === 'submit' ? (v?.content ?? null) : null,
        changed: r.step === 'submit' && (v?.changed ?? false),
        dispositions: r.step === 'submit' ? dispositions(r.dispositions) : [],
        directionQuestions: r.directionQuestions,
        attempts: r.step === 'submit' ? r.attempts : [],
        result: hb.resultHash,
      };
    }
    case 'interpreter': {
      const card = cardOf<InterpreterCard>(p, q);
      const r = hb.result as InterpreterResult;
      const content = put(interpretationDocument(card, r));
      const same = card.current !== null && card.current.content === content;
      return {
        kind: 'interpretation',
        task: q.task,
        version: same && card.current !== null ? card.current.version : versionId(card.newVersion, content),
        content,
        changed: !same,
        noConclusion: interpretationHasNoConclusion(r),
        message: r.message,
        dispositions: dispositions(r.dispositions),
        result: hb.resultHash,
      };
    }
    case 'attacker': {
      const card = cardOf<CrititorCard>(p, q);
      const r = hb.result as CrititorResult;
      if (card.mode === 'discuss') return { kind: 'discuss-reply', task: q.task, reply: r.reply, result: hb.resultHash };
      const ids = crititorFindingIds(card, r, hb.launch, put);
      const o = attackOutcome(card.priorFindings, r);
      return {
        kind: 'attack',
        task: q.task,
        target: card.target ?? '',
        judgment: card.binding?.judgment ?? '',
        verdict: o.verdict,
        fresh: card.fresh,
        findings: r.findings.map((f, i) => ({ id: ids[i] as string, severity: f.severity, class: f.class, title: f.title, doc: put(crititorFindingDocument(card, f, hb.launch)) })),
        rechecks: r.rechecks.map((c) => ({ finding: c.finding, resolved: c.resolved, reason: c.reason })),
        settled: r.settled,
        reply: r.reply,
        result: hb.resultHash,
      };
    }
    case 'executor': {
      const card = cardOf<ExperimentCard | ReaderCard>(p, q);
      const r = hb.result as BlindResult;
      const rec = blindRecordOf(p, card, r, hb);
      const status = rec.fields['status'] === 'completed' ? 'completed' : 'unverified';
      return {
        kind: 'evidence',
        task: q.task,
        evidence: card.evidence.id,
        status,
        summary: `${status === 'unverified' ? `UNVERIFIED (${rec.fields['unbacked'] ?? '?'} claim(s) rest on no program record) | ` : ''}${blindSummary(card, r)}`,
        report: rec.fields['report'] ?? put(blindReportDocument(card, r)),
        attempt: card.evidence.attempt,
        auto: false,
      };
    }
  }
}

/**
 * The evidence record of a blind run (review r1 #20): a reading's comes with the hand-back (the
 * host checked its fetch:<k> pointers against the pages it fetched); an experiment's is the
 * program's, written here from the claims checked against the launch's run records.
 */
function blindRecordOf(p: ExplorationPorts, card: ExperimentCard | ReaderCard, r: BlindResult, hb: NonNullable<FlowTaskStatus['handBack']>): EvidenceRecord {
  if (card.seat === 'researcher-reader') {
    const rec = hb.records.find((x): x is EvidenceRecord => x.kind === 'evidence' && x.evidence === card.evidence.id);
    if (rec !== undefined) return rec;
  }
  const runs = hb.records.filter((x): x is RunLayerRecord => x.kind === 'run.layer').map((x) => ({ run: x.run as string, status: x.status as string }));
  return blindEvidenceRecord(card, r, card.seat === 'researcher-reader' ? 'reading' : 'experiment', { content: p.ledger.content }, card.seat === 'researcher-reader' ? null : runs);
}

function blindSummary(card: { readonly assertions: readonly string[] }, r: BlindResult): string {
  const a = r.assertions
    .slice()
    .sort((x, y) => x.assertion - y.assertion)
    .map((x) => `#${x.assertion} ${x.holds === 'yes' ? 'holds' : x.holds === 'no' ? 'does not hold' : 'not checked'}`);
  const m = r.measurements.map((x) => `${x.measure}=${x.value}`);
  const notDone = r.steps.filter((x) => x.done !== 'yes').map((x) => `step ${x.step} ${x.done}`);
  const text = [a.length > 0 ? `assertions: ${a.join(', ')}` : '', m.length > 0 ? `recorded: ${m.join('; ')}` : '', notDone.length > 0 ? `not done: ${notDone.join(', ')}` : '', card.assertions.length === 0 && m.length === 0 ? 'no quantities' : '']
    .filter((t) => t !== '')
    .join(' | ');
  return text.length <= 400 ? text : `${text.slice(0, 397)}...`;
}

/** Notices a consumption brings (3.9, 3.11): direction questions go up (3.2: direction is the user's). */
async function notifyConsumption(p: ExplorationPorts, mission: MissionId, x: string, s: XState, q: QueuedBody, c: ConsumedBody): Promise<void> {
  if (c.kind !== 'author' && c.kind !== 'interpretation') return;
  const escalated = c.dispositions.filter((d) => d.action === 'escalate');
  const questions = c.kind === 'author' ? c.directionQuestions : [];
  if (escalated.length === 0 && questions.length === 0) return;
  const n: FlowNotice = {
    category: 'exploration-direction-question',
    wi: null,
    key: `${x}:${q.task}`,
    mission,
    trigger: `the author of exploration ${x} raised ${escalated.length + questions.length} direction question(s) (4.3 discuss, 8.2 escalate)`,
    defaultAction: `the exploration goes on; the questions go to the Secretary (exploration-direction escalations), who decides or asks the user (3.2); escalated findings stay unresolved until the ruling, and convergence waits for it`,
    detail: {
      exploration: x,
      round: s.rounds,
      questions,
      escalated: escalated.map((d) => ({ finding: d.finding, title: s.findings.get(d.finding)?.title ?? null, question: d.question, note: d.note })),
    },
  };
  await p.ledger.notify(n);
}

// ---------------------------------------------------------------- performing an action

function taskOf(s: XState, task: string, lineage: string, card: AnyCard): FlowTask {
  const def = s.def as ExplorationDefinition;
  return {
    task,
    lineage,
    mission: def.mission as MissionId,
    card,
    priority: def.priority,
    capabilities: (card as { capabilities?: readonly string[] }).capabilities ?? def.capabilities,
    mode: def.mode,
    estimateMicros: 0,
  };
}

async function submitQueued(p: ExplorationPorts, mission: MissionId, x: string, s: XState, q: Omit<QueuedBody, 'card'>, card: AnyCard, supersedes: string | null): Promise<void> {
  const cardHash = p.ledger.content.put(canonicalJson(card));
  const t = taskOf(s, q.task, q.lineage, card);
  if (supersedes !== null) await p.scheduler.supersede(supersedes, t);
  else await p.scheduler.submit(t);
  const body: QueuedBody = { ...q, card: cardHash };
  await p.ledger.append(xid.op(mission, x, `queue:${q.n}`), { events: [{ mission, line: line(x), event: 'queued', key: String(q.n), body }] });
}

const asCard = (c: object): AnyCard => c as unknown as AnyCard;

async function perform(p: ExplorationPorts, mission: MissionId, x: string, s: XState, a: Exclude<Action, { kind: 'none' }>): Promise<void> {
  const lineage = xid.lineage(mission, x);
  const n = s.seq + 1;
  const base = { n, round: s.rounds, phase: s.phase, fresh: false, target: null, judgment: null, evidence: null, resumeOf: null, versionPrefix: null, lineage };
  switch (a.kind) {
    case 'stop':
      await stop(p, mission, x, s, a.reason, a.wi);
      return;
    case 'author': {
      const task = xid.task(mission, x, n, 'author');
      await submitQueued(p, mission, x, s, { ...base, task, role: 'author', purpose: 'author', versionPrefix: xid.versionPrefix(mission, x, n) }, asCard(authorCard(s, n, task, p.ledger.content, null)), null);
      return;
    }
    case 'interpreter': {
      const task = xid.task(mission, x, n, 'interpreter');
      await submitQueued(p, mission, x, s, { ...base, task, role: 'interpreter', purpose: 'interpret', versionPrefix: xid.versionPrefix(mission, x, n) }, asCard(interpreterCard(s, n, task, p.ledger.content)), null);
      return;
    }
    case 'attacker': {
      const task = xid.task(mission, x, n, 'attacker');
      const card = attackerCard(s, n, task, p.ledger.content, a.mode, a.fresh, null);
      await submitQueued(p, mission, x, s, { ...base, task, role: 'attacker', purpose: a.mode, fresh: a.fresh, target: card.target, judgment: card.binding?.judgment ?? null }, asCard(card), null);
      return;
    }
    case 'evidence': {
      const aw = s.awaitingEvidence;
      if (aw === null) return;
      const k = s.evidenceSeq + 1;
      const evidence = xid.evidence(mission, x, k);
      const task = xid.task(mission, x, n, 'executor');
      const doc = aw.request !== null ? safeGet(p, aw.request) : null;
      const req: EvidenceRequestDoc | null = doc === null ? null : parseEvidenceRequest(doc);
      const executor = req?.executor ?? (s.def as ExplorationDefinition).evidenceExecutor;
      const evLineage = xid.evidenceLineage(mission, x, k);
      if (req === null || a.overCap) {
        // an unreadable request, or one past the turn's cap (6.5): the program records the run as
        // not run (8.2) and the requester goes on with that answer
        const why = req === null ? 'the evidence request could not be read' : `this turn already asked for ${(s.def as ExplorationDefinition).evidencePerTurn} evidence run(s), the cap of one turn (6.5): hand back your result, or ask again in a later turn`;
        if (req !== null) {
          await p.ledger.notify({
            category: 'exploration-evidence-cap',
            wi: 'WI-08',
            key: `${x}:${aw.requester}`,
            mission,
            trigger: `a seat of exploration ${x} (task ${aw.requester}) asked for more evidence runs in one turn than the cap of ${(s.def as ExplorationDefinition).evidencePerTurn} (6.5)`,
            defaultAction: 'the request is recorded as not run and the seat resumes with that answer; its next hand-back counts as usual; nothing else is affected',
            detail: { exploration: x, requester: aw.requester, request: aw.request, cap: (s.def as ExplorationDefinition).evidencePerTurn },
          });
        }
        const info = { id: evidence, k, attempt: null, executor, requester: aw.requester };
        const rec = failedEvidenceRecord({ id: evidence, envLine: (s.defined as DefinedBody).envLine, envSnapshot: (s.defined as DefinedBody).envSnapshot, attempt: null }, 'not-run', why, executor);
        const cardHash = p.ledger.content.put(canonicalJson({ notRun: aw.request, why }));
        const q: QueuedBody = { ...base, task, lineage: evLineage, role: 'executor', purpose: 'evidence', evidence: info, card: cardHash };
        const c: ConsumedBody = { kind: 'evidence', task, evidence, status: 'not-run', summary: `not run: ${why}`, report: null, attempt: null, auto: true };
        await p.ledger.append(xid.op(mission, x, `queue:${n}`), {
          events: [
            { mission, line: line(x), event: 'queued', key: String(n), body: q },
            { mission, line: line(x), event: 'consumed', key: task, body: c },
          ],
          records: [rec],
        });
        return;
      }
      const card = executorCard(s, task, p.ledger.content, req, executor, { id: evidence, attempt: null });
      await submitQueued(p, mission, x, s, { ...base, task, lineage: evLineage, role: 'executor', purpose: 'evidence', evidence: { id: evidence, k, attempt: null, executor, requester: aw.requester } }, asCard(card), null);
      return;
    }
    case 'attempts': {
      // one at a time (each its own op); the loop in advanceExploration queues the rest
      const at = a.attempts[0];
      if (at === undefined) return;
      const k = s.evidenceSeq + 1;
      const evidence = xid.evidence(mission, x, k);
      const task = xid.task(mission, x, n, 'executor');
      const card = executorCard(s, task, p.ledger.content, at, at.kind, { id: evidence, attempt: at.id });
      await submitQueued(p, mission, x, s, { ...base, task, lineage: xid.evidenceLineage(mission, x, k), role: 'executor', purpose: 'attempt', evidence: { id: evidence, k, attempt: at.id, executor: at.kind, requester: null } }, asCard(card), null);
      return;
    }
    case 'resume': {
      const aw = s.awaitingEvidence;
      const rq = s.tasks.get(a.requester);
      if (aw === null || rq === undefined) return;
      const ev = aw.evidence !== null ? s.evidence.get(aw.evidence) : undefined;
      const text = ev === undefined ? 'The evidence run left no record.' : `Evidence ${ev.id} (${ev.status}): ${ev.summary}${ev.report !== null ? `\nFull report: material evidence-${ev.id}.` : ''}`;
      let resume: Resume | null = null;
      if (aw.sessionId !== null) resume = { sessionId: aw.sessionId, state: aw.recoveryState, evidence: text };
      else {
        // WI-17: no session to resume: a new session from what the ledger holds (6.2)
        await p.ledger.notify({
          category: 'exploration-recovery-state-missing',
          wi: 'WI-17',
          key: `${x}:${a.requester}`,
          mission,
          trigger: `the ${rq.role} of exploration ${x} asked for evidence (task ${a.requester}) but no session id was kept, so its session cannot be resumed (6.2)`,
          defaultAction: 'a new session starts with a card holding the ledger material (the current version, every finding and disposition, the evidence results); only the conversation is lost',
          detail: { exploration: x, requester: a.requester, recoveryState: aw.recoveryState, evidence: aw.evidence },
        });
      }
      const task = xid.task(mission, x, n, rq.role);
      const common = { ...base, task, role: rq.role, resumeOf: a.requester, lineage: rq.lineage };
      if (rq.role === 'author') {
        await submitQueued(p, mission, x, s, { ...common, purpose: 'author', versionPrefix: xid.versionPrefix(mission, x, n) }, asCard(authorCard(s, n, task, p.ledger.content, resume)), a.requester);
      } else if (rq.role === 'attacker') {
        const mode = rq.purpose === 'discuss' ? 'discuss' : 'attack';
        const card = attackerCard(s, n, task, p.ledger.content, mode, rq.fresh, resume);
        await submitQueued(p, mission, x, s, { ...common, purpose: mode, fresh: rq.fresh, target: card.target, judgment: card.binding?.judgment ?? null }, asCard(card), a.requester);
      } else {
        // interpreters and executors have no request_evidence tool; nothing to resume
        await submitQueued(p, mission, x, s, { ...common, purpose: 'interpret', versionPrefix: xid.versionPrefix(mission, x, n) }, asCard(interpreterCard(s, n, task, p.ledger.content)), a.requester);
      }
      return;
    }
  }
}

function safeGet(p: ExplorationPorts, hash: string): string | null {
  try {
    return p.ledger.content.get(hash);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- stopping and the hand-off (8.2)

export interface ExplorationHandoff {
  readonly format: 'mp4.exploration-handoff.v1';
  readonly exploration: string;
  readonly mission: string;
  readonly reason: StopReason;
  readonly wi: string | null;
  /** Who accepts (8.2 验收, 3.2): direction-type decisions go to the user, structure-type to the Secretary. */
  readonly acceptance: 'user' | 'secretary';
  readonly decision: ExplorationDefinition['decision'];
  readonly goal: string;
  readonly version: { readonly id: string; readonly content: string } | null;
  readonly rounds: number;
  readonly allowedRounds: number;
  /** The last attack: its judgment and the attack text (the seat's hand-back document). */
  readonly lastAttack: { readonly judgment: string; readonly verdict: string; readonly target: string; readonly result: string | null } | null;
  /** Every finding with its disposition (8.2 处置表). */
  readonly findings: ReadonlyArray<{
    readonly id: string;
    readonly severity: string;
    readonly class: string;
    readonly title: string;
    readonly round: number;
    readonly phase: string;
    readonly status: string;
    readonly disposition: Disposition | null;
    readonly rechecks: ReadonlyArray<{ readonly round: number; readonly resolved: string; readonly reason: string }>;
    readonly residualRisk: boolean;
    readonly ruling: string | null;
  }>;
  readonly unresolvedBlocking: readonly string[];
  readonly residualRisks: readonly string[];
  readonly evidence: ReadonlyArray<{ readonly id: string; readonly status: string; readonly summary: string; readonly attempt: string | null }>;
  readonly questions: readonly string[];
  /** Research explorations: whether the key answer does not stand (8.2 "没有结论"). */
  readonly research: { readonly noConclusion: boolean; readonly method: string | null } | null;
}

/** The hand-off document of the state as it is (8.2: version, disposition table, residual risks). */
export function buildHandoff(s: XState, reason: StopReason, wi: string | null): ExplorationHandoff {
  const def = s.def as ExplorationDefinition;
  const findings = [...s.findings.values()];
  return {
    format: 'mp4.exploration-handoff.v1',
    exploration: def.exploration,
    mission: def.mission,
    reason,
    wi,
    acceptance: def.decision.type === 'direction' || (def.research && s.noConclusion) ? 'user' : 'secretary',
    decision: def.decision,
    goal: def.goal,
    version: s.version === null ? null : { id: s.version.id, content: s.version.content },
    rounds: s.rounds,
    allowedRounds: allowedRounds(s),
    lastAttack: s.lastAttack === null ? null : { judgment: s.lastAttack.judgment, verdict: s.lastAttack.verdict, target: s.lastAttack.target, result: s.lastAttack.result },
    findings: findings.map((f) => ({ id: f.id, severity: f.severity, class: f.class, title: f.title, round: f.round, phase: f.phase, status: f.status, disposition: f.disposition, rechecks: f.rechecks, residualRisk: f.residualRisk, ruling: f.ruling })),
    unresolvedBlocking: findings.filter((f) => (f.severity === 'fatal' || f.severity === 'serious') && f.status !== 'resolved').map((f) => f.id),
    residualRisks: findings.filter((f) => f.residualRisk).map((f) => f.id),
    evidence: [...s.evidence.values()].map((e) => ({ id: e.id, status: e.status, summary: e.summary, attempt: e.attempt })),
    questions: [...s.questions],
    research: def.research ? { noConclusion: s.noConclusion, method: s.method?.version ?? null } : null,
  };
}

const DECIDE = 'the Secretary decides (an escalation on this exploration; WI-08 for the PM): grant more rounds (the Secretary once, then only the user), accept the current version with its open findings as residual risks, send it back with a new direction, re-plan, or give it up';

const STOP_TEXT: Readonly<Record<StopReason, { readonly category: string; readonly trigger: string; readonly action: string }>> = {
  converged: {
    category: 'exploration-converged',
    trigger: 'the latest round on the frozen version, the closing attacker\'s included, left no unresolved fatal or serious finding (8.2 stop 1)',
    action: 'no further round is queued; the product and its disposition table go to acceptance (8.2 acceptance): the decision layer routes it by decision type (3.10)',
  },
  'budget-exhausted': {
    category: 'exploration-budget-exhausted',
    trigger: 'the exploration used its budget (rounds, or its own spend limit) without converging (8.2 stop 2, 6.5)',
    action: `no further round is queued; nothing else is affected; ${DECIDE}`,
  },
  'fatal-repeat': {
    category: 'exploration-fatal-repeat',
    trigger: 'a fatal finding of the same class was not fixed in two consecutive rounds (8.2 stop 3)',
    action: `no further round is queued; the direction may need to change; ${DECIDE}`,
  },
  'no-progress': {
    category: 'exploration-no-progress',
    trigger: 'two consecutive rounds ended with the same unresolved fatal or serious findings and nothing new (6.5 no-progress)',
    action: `no further round is queued; prefer a different approach over more rounds; ${DECIDE}`,
  },
  'seat-abandoned': {
    category: 'exploration-seat-abandoned',
    trigger: 'an author, attacker or interpreter task of the exploration was given up after its failure (WI-15)',
    action: 'no further round is queued; nothing else is affected. The PM retries the turn (recordExplorationRuling "retry") or stops the exploration ("stop")',
  },
  'stopped-by-decision': {
    category: 'exploration-stopped',
    trigger: 'the decision layer stopped the exploration',
    action: 'no further round is queued; the current state is handed back',
  },
};

async function stop(p: ExplorationPorts, mission: MissionId, x: string, s: XState, reason: StopReason, wi: string | null): Promise<void> {
  const n = s.stops + 1;
  const h = buildHandoff(s, reason, wi);
  const handoff = p.ledger.content.put(canonicalJson(h));
  const t = STOP_TEXT[reason];
  await p.ledger.notify({
    category: t.category,
    wi,
    key: `${x}:${n}`,
    mission,
    trigger: `exploration ${x}: ${t.trigger}; ${s.rounds} of ${allowedRounds(s)} rounds used`,
    defaultAction: t.action,
    detail: { exploration: x, handoff, version: h.version?.id ?? null, unresolvedBlocking: h.unresolvedBlocking, residualRisks: h.residualRisks, acceptance: h.acceptance },
  });
  const body: StoppedBody = { n, reason, wi, handoff, version: s.version?.id ?? null };
  await p.ledger.append(xid.op(mission, x, `stop:${n}`), { events: [{ mission, line: line(x), event: 'stopped', key: String(n), body }] });
}

/** The hand-offs of a mission's explorations (for the decision layer: Secretary, PM, 3.8, 3.10). */
export async function explorationHandoffs(ledger: FlowLedgerPort, mission: MissionId): Promise<Array<{ readonly exploration: string; readonly stopped: StoppedBody; readonly handoff: ExplorationHandoff }>> {
  const evs = await ledger.events<StoppedBody>({ mission, event: 'stopped' });
  return evs
    .filter((e) => e.line.startsWith('exploration:'))
    .map((e) => ({ exploration: e.line.slice('exploration:'.length), stopped: e.body, handoff: JSON.parse(ledger.content.get(e.body.handoff)) as ExplorationHandoff }));
}

/** The folded state of one exploration (read-only; for status views and tests). */
export async function explorationState(p: Pick<ExplorationPorts, 'ledger'>, mission: MissionId, x: string): Promise<XState> {
  const events = await p.ledger.events({ mission, line: line(x) });
  return fold(events.map((e) => ({ event: e.event, key: e.key, body: e.body })));
}

