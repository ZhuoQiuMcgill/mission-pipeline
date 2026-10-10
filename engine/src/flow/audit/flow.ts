// Legalization (design 11.1, 5.2 part 3, 6.1, 10.1): an independent unit of work, started only
// when the user asks (through the PM). The program first computes the backfill list and the
// number of seats it will start, and the user sees it before the audit starts. Then:
//
//   1. node backfills, one generation at a time from the top of the lineage: a node whose
//      parents are all proven gets a new Auditor instance on its required review positions that
//      are missing, undecided or not current (or, when only constraint coverage is missing, a
//      full review of one position). Backfilling a parent often restores its children's
//      judgments by itself, so a child is backfilled only if it is still not proven afterwards.
//   2. the chain-acceptance object: the endpoint, every node of the chain, the user's words in
//      force; its required review is "auditor-chain", relying on every node of the chain.
//   3. the chain Auditor judges it (the user's words honoured, the seams hold).
//   4. the stamp: a proof-conditioned operation (6.1) over the chain-acceptance object: registered
//      (op.pending), then executed "as of" the published revision at which it is all proven.
//      Any later change that affects the chain object takes the stamp off (the evaluator's
//      episodes, 6.1); revoking only the chain evidence leaves the nodes proven.
//
// A broken link (a negated or withdrawn node on a required path), a backfill that does not
// prove its node, or a chain judgment that does not pass ends the legalization with a work
// result for the PM and the proposed WI-25 (src/flow/exploration/WI-NEEDED.md): nothing else
// stops, and a new legalization (a new chain object) can follow once the cause is dealt with.
//
// Restartable like every flow: state is the fold of the line "audit:<id>"; every step has a
// fixed identity.

import { canonicalJson } from '../../common/hash.ts';
import type { MissionId, ObjectVersionId, OpId } from '../../common/ids.ts';
import { encodeConstraintCheck, type EvidenceRecord, type JudgmentRecord, type ObjectVersionRecord, type ProofUnitRecord, type ReviewContract } from '../../common/records.ts';
import { constraintApplies, requiredRange } from '../../evaluator/semantics.ts';
import { SEAMS_ON_CARD, seamTable, type AuditChainCard, type AuditChainResult, type AuditNodeCard, type AuditNodeResult, type AuditPositionT } from '../../seat/cards/auditor.ts';
import { materialPageCount, type MaterialRef } from '../../seat/cards/common.ts';
import { SEAT_CAPABILITIES, basisIndex, flowCtx, idPart, type FlowCtx } from '../context.ts';
import type { AnyCard, FlowPorts, FlowTaskStatus } from '../ports.ts';
import { handleFailure } from '../failures.ts';
import { detailedPlanOf, standardLine, type EffectiveBody } from '../planning.ts';
import { PLAN_LINE, REQUIREMENTS_LINE } from '../plandoc.ts';
import { currentConstraints, currentItems, requirementSetLine, type ItemVersionBody } from '../requirements.ts';
import { markApplied } from '../secretary.ts';
import { lineageSource, nextGeneration, walkLineage, type Lineage, type LineageNode } from './lineage.ts';

/** The proposed WI for a legalization that cannot complete (src/flow/exploration/WI-NEEDED.md). */
export const WI_LEGALIZATION = 'WI-25';

/** Legalization ids go into ledger and launch ids: letters, digits, "." and "-". */
const SAFE = /^[A-Za-z0-9][A-Za-z0-9.-]{0,60}$/;

/** Legalization ids are unique within a mission only: the mission (no ".") is in every global id (review r1 #17), the id encoded injectively (idPart, review r2). */
const ltok = (m: string, l: string): string => `${m}.${idPart(l)}`;

export const aid = {
  line: (l: string) => `audit:${l}`,
  op: (m: string, l: string, what: string) => `aud:${ltok(m, l)}:${what}`,
  lineage: (m: string, l: string) => `aud.${ltok(m, l)}`,
  task: (m: string, l: string, n: number, kind: 'node' | 'chain') => `aud.${ltok(m, l)}.${n}.${kind}`,
  judgment: (m: string, l: string, n: number, i: number) => `audj.${ltok(m, l)}.${n}.${i}`,
  chainJudgment: (m: string, l: string, n: number) => `audc.${ltok(m, l)}.${n}`,
  chainObject: (m: string, l: string) => `chain.${ltok(m, l)}`,
  /** The stamp's proof-conditioned operation; a new one after the ledger ended an earlier one (6.1, WI-11). */
  stampOp: (m: string, l: string, k: number) => `legal.${ltok(m, l)}${k > 1 ? `.r${k}` : ''}`,
};

export interface LegalizationRequest {
  readonly legalization: string;
  readonly mission: string;
  /** The endpoint: an object version or a proof unit. */
  readonly endpoint: string;
  /** The user's words asking for it (verbatim). */
  readonly words: string;
  /** Seam verification runs (7.3) the chain Auditor judges with: the chain evidence. */
  readonly chainEvidence: readonly string[];
  readonly capabilities: readonly string[];
}

// ---------------------------------------------------------------- events and state

interface PlanBody {
  readonly endpoint: string;
  readonly nodes: readonly LineageNode[];
  readonly chain: readonly string[];
  readonly pending: readonly string[];
  readonly blocked: ReadonlyArray<{ readonly id: string; readonly label: string; readonly path: readonly string[] }>;
  /** Upper bound of the seats (one Auditor per pending node, plus the chain Auditor). */
  readonly seats: number;
  readonly snapshot: string;
  /** Branches excluded because only reference edges lead there (11.1); reference edges are not recorded yet. */
  readonly excluded: readonly string[];
}

interface QueuedBody {
  readonly n: number;
  readonly task: string;
  readonly kind: 'node' | 'chain';
  readonly node: string;
  readonly card: string;
  readonly positions: readonly string[];
}

interface ConsumedBody {
  readonly task: string;
  readonly kind: 'node' | 'chain' | 'abandoned';
  readonly node: string;
  readonly verdicts: Readonly<Record<string, string>>;
  readonly judgments: readonly string[];
}

export type LegalizationOutcome = 'stamped' | 'refused' | 'not-legalized' | 'chain-refused';

interface ResultBody {
  readonly outcome: LegalizationOutcome;
  readonly wi: string | null;
  readonly why: string;
  readonly nodes: readonly string[];
  readonly stamp: { readonly op: string; readonly asOf: number; readonly chainObject: string; readonly excluded: readonly string[] } | null;
}

export interface LegalizationState {
  request: LegalizationRequest | null;
  plan: PlanBody | null;
  started: boolean;
  seq: number;
  readonly tasks: Map<string, QueuedBody>;
  readonly consumed: Map<string, ConsumedBody>;
  chain: { readonly object: string; readonly content: string } | null;
  /** The stamp's operations, oldest first (a new one after the ledger ended one, WI-11). */
  readonly ops: string[];
  result: ResultBody | null;
}

function foldAudit(events: ReadonlyArray<{ event: string; body: unknown }>): LegalizationState {
  const s: LegalizationState = { request: null, plan: null, started: false, seq: 0, tasks: new Map(), consumed: new Map(), chain: null, ops: [], result: null };
  for (const e of events) {
    switch (e.event) {
      case 'requested':
        s.request = e.body as LegalizationRequest;
        break;
      case 'planned':
        s.plan = e.body as PlanBody;
        break;
      case 'started':
        s.started = true;
        break;
      case 'queued': {
        const q = e.body as QueuedBody;
        s.tasks.set(q.task, q);
        s.seq = Math.max(s.seq, q.n);
        break;
      }
      case 'consumed': {
        const c = e.body as ConsumedBody;
        s.consumed.set(c.task, c);
        break;
      }
      case 'chain':
        s.chain = e.body as { object: string; content: string };
        break;
      case 'op':
        s.ops.push((e.body as { op: string }).op);
        break;
      case 'result':
        s.result = e.body as ResultBody;
        break;
    }
  }
  return s;
}

async function load(ports: FlowPorts, mission: MissionId, l: string): Promise<LegalizationState> {
  return foldAudit(await ports.ledger.events({ mission, line: aid.line(l) }));
}

export async function legalizationState(ports: FlowPorts, mission: MissionId, l: string): Promise<LegalizationState> {
  return load(ports, mission, l);
}

// ---------------------------------------------------------------- request, plan, start

/**
 * The user asked for a legalization (through the PM). The program computes the backfill list
 * and the seats it will start; the PM shows them to the user, who starts it (startLegalization).
 * A broken link ends it at once (11.1: the endpoint cannot be legalized), with WI-25.
 */
export async function requestLegalization(ports: FlowPorts, req: LegalizationRequest): Promise<PlanBody> {
  if (!SAFE.test(req.legalization)) throw new Error(`bad legalization id ${JSON.stringify(req.legalization)}`);
  const mission = req.mission as MissionId;
  const ctx = flowCtx(ports, mission);
  const line = aid.line(req.legalization);
  const prior = await load(ports, mission, req.legalization);
  if (prior.plan !== null) {
    // a crash after the plan was persisted: its notice again (idempotent)
    if (prior.result === null) await notifyPlan(ports, mission, req.legalization, prior.plan);
    else await notifyResult(ports, mission, req.legalization, prior);
    return prior.plan;
  }
  const lin = await lineage(ctx, req.endpoint);
  const snapshot = await ports.scheduler.snapshot({ mission, purpose: `legalization-${req.legalization}` });
  const plan: PlanBody = {
    endpoint: lin.endpoint,
    nodes: [...lin.nodes.values()],
    chain: lin.chain,
    pending: lin.pending,
    blocked: lin.blocked.map((b) => ({ id: b.id, label: b.label, path: b.path })),
    seats: lin.pending.length + 1,
    snapshot: snapshot.path,
    excluded: [],
  };
  const events = [
    { mission, line, event: 'requested', key: 'request', body: req },
    { mission, line, event: 'planned', key: 'plan', body: plan },
  ];
  if (plan.blocked.length > 0) {
    const why = `the endpoint ${plan.endpoint} rests on ${plan.blocked.map((b) => `${b.id} (${b.label}; path ${b.path.join(' → ')})`).join(', ')} through required edges only: no backfill can prove a negated or withdrawn node (an Auditor never revokes a negation, 5.2), so the endpoint cannot be legalized (11.1)`;
    const result: ResultBody = { outcome: 'refused', wi: WI_LEGALIZATION, why, nodes: plan.blocked.map((b) => b.id), stamp: null };
    await ports.ledger.append(aid.op(req.mission, req.legalization, 'plan'), { events: [...events, { mission, line, event: 'result', key: 'result', body: result }] });
    await notifyResult(ports, mission, req.legalization, await load(ports, mission, req.legalization));
    return plan;
  }
  await ports.ledger.append(aid.op(req.mission, req.legalization, 'plan'), { events });
  await notifyPlan(ports, mission, req.legalization, plan);
  return plan;
}

/** The plan's notice (11.1: visible before the audit starts), after it is persisted; idempotent. */
async function notifyPlan(ports: FlowPorts, mission: MissionId, l: string, plan: PlanBody): Promise<void> {
  await ports.ledger.notify({
    category: 'legalization-plan',
    wi: null,
    key: l,
    mission,
    trigger: `legalization ${l} of ${plan.endpoint} was asked for: ${plan.pending.length} node(s) of ${plan.chain.length} in the chain are not fully proven`,
    defaultAction: `nothing started yet: at most ${plan.pending.length} node Auditor(s) and 1 chain Auditor (${plan.seats} seats) will run once the user starts it (fewer when a backfilled parent restores its children)`,
    detail: { legalization: l, endpoint: plan.endpoint, pending: plan.pending, chain: plan.chain, seats: plan.seats },
    askUser: true,
  });
}

/** The user saw the plan and starts the legalization (the user's words, verbatim). */
export async function startLegalization(ports: FlowPorts, mission: MissionId, l: string, words: string): Promise<void> {
  const s = await load(ports, mission, l);
  if (s.plan === null) throw new Error(`legalization ${l} has no plan (requestLegalization first)`);
  if (s.result !== null) throw new Error(`legalization ${l} already ended (${s.result.outcome}); ask for a new one`);
  await ports.ledger.append(aid.op(mission, l, 'start'), { events: [{ mission, line: aid.line(l), event: 'started', key: 'start', body: { words } }] });
}

async function lineage(ctx: FlowCtx, endpoint: string): Promise<Lineage> {
  const objects = (await ctx.ports.ledger.records(['object.version'])).map((c) => c.record as ObjectVersionRecord);
  const units = (await ctx.ports.ledger.records(['proof.unit'])).map((c) => c.record as ProofUnitRecord);
  const src = lineageSource(objects, units, ctx.ports.ledger.content);
  // labels at one published revision (6.1)
  const all = [...src.objects.keys(), ...src.units.keys()];
  const labels = (await ctx.ports.evaluator.labels(all)).labels;
  return walkLineage(src, endpoint, (ids) => Object.fromEntries(ids.map((i) => [i, labels[i] ?? null])));
}

// ---------------------------------------------------------------- advance

export interface LegalizationReport {
  readonly legalization: string;
  readonly steps: number;
  readonly state: 'waiting' | 'ended' | 'unknown';
  readonly why: string;
  readonly result: ResultBody | null;
}

export async function advanceLegalization(ports: FlowPorts, mission: MissionId, l: string, maxSteps = 64): Promise<LegalizationReport> {
  let steps = 0;
  for (;;) {
    const s = await load(ports, mission, l);
    const done = (state: LegalizationReport['state'], why: string): LegalizationReport => ({ legalization: l, steps, state, why, result: s.result });
    if (s.request === null || s.plan === null) return done('unknown', 'not requested');
    if (s.result !== null) {
      await notifyResult(ports, mission, l, s);
      return done('ended', s.result.outcome);
    }
    if (!s.started) return done('waiting', 'the user has not started it');
    if (steps >= maxSteps) return done('waiting', 'step budget of this call used; call again');
    const why = await step(ports, mission, l, s);
    if (why !== null) return done('waiting', why);
    steps++;
  }
}

/** Takes one step; returns why it waits (null: a step was taken). */
async function step(ports: FlowPorts, mission: MissionId, l: string, s: LegalizationState): Promise<string | null> {
  const ctx = flowCtx(ports, mission);
  const plan = s.plan as PlanBody;
  const req = s.request as LegalizationRequest;
  const line = aid.line(l);

  // 1. take finished tasks into account
  for (const q of [...s.tasks.values()].filter((t) => !s.consumed.has(t.task)).sort((a, b) => a.n - b.n)) {
    const st = await ports.scheduler.status(q.task);
    if (st === null) {
      await ports.scheduler.submit(taskOf(req, q.task, JSON.parse(ports.ledger.content.get(q.card)) as AnyCard));
      continue;
    }
    if (st.state === 'needs-disposition' || st.state === 'exhausted' || (st.state === 'done' && st.handBack?.status !== 'handed-back')) {
      // a failed Auditor goes to the Secretary like any flow's seat (failures.ts: restart, grant, abandon; WI-15, WI-08)
      const why = st.state === 'exhausted' ? 'exhausted' : st.disposition === 'full-review' ? 'full-review' : 'needs-disposition';
      const o = await handleFailure(ctx, { task: q.task, lineage: aid.lineage(mission, l), subject: line, view: { kind: 'failed', status: st, why }, canAbandon: true, canReplan: false });
      if (o.kind === 'decided') {
        await ports.scheduler.cancel(q.task);
        await markApplied(ctx, o.escalation, { option: o.decision.option, task: q.task });
        return null;
      }
      continue;
    }
    const c = consumption(q, st);
    if (c === null) continue;
    await ports.ledger.append(aid.op(mission, l, `consume:${q.task}`), { events: [{ mission, line, event: 'consumed', key: q.task, body: c }] });
    return null;
  }
  const running = [...s.tasks.values()].filter((t) => !s.consumed.has(t.task));
  const abandoned = [...s.consumed.values()].find((c) => c.kind === 'abandoned');
  if (abandoned !== undefined) return end(ports, mission, l, 'not-legalized', `the Auditor of ${abandoned.node} was given up (WI-15)`, [abandoned.node]);

  // 2. the evaluator must have seen every judgment made so far (6.1: labels as of a published revision)
  const made = new Set([...s.consumed.values()].flatMap((c) => c.judgments));
  let needed = 0;
  if (made.size > 0) for (const c of await ports.ledger.records(['judgment'])) if (made.has(c.record.judgment)) needed = Math.max(needed, c.revision);
  const ids = s.chain !== null ? [...plan.chain, s.chain.object] : [...plan.chain];
  const lab = await ports.evaluator.labels(ids);
  if (lab.revision < needed) return `the evaluator has not published revision ${needed} yet`;
  const proven = (id: string): boolean => lab.labels[id] === 'proven';

  // 3. a node that became negated or withdrawn: the endpoint cannot be legalized
  const broken = plan.chain.filter((id) => lab.labels[id] === 'negated' || lab.labels[id] === 'basis-withdrawn');
  if (broken.length > 0) return end(ports, mission, l, 'not-legalized', `${broken.map((b) => `${b} is ${lab.labels[b]}`).join(', ')} (after the backfill, or changed since the plan)`, broken);

  // 4. node backfills, top generation first
  const remaining = plan.chain.filter((id) => !proven(id));
  if (remaining.length > 0) {
    const lin: Lineage = { endpoint: plan.endpoint, nodes: new Map(plan.nodes.map((n) => [n.id, n])), chain: plan.chain, pending: remaining, blocked: [] };
    const gen = nextGeneration(lin, proven);
    if (gen.length === 0) return end(ports, mission, l, 'not-legalized', `no node can be backfilled: ${remaining.join(', ')} wait on each other (a cycle without a proof unit, WI-16)`, remaining);
    // every node of the generation gets its own Auditor, side by side
    let next: string | null = null;
    for (const node of gen) {
      const prior = [...s.tasks.values()].find((t) => t.kind === 'node' && t.node === node);
      if (prior === undefined) {
        next ??= node;
        continue;
      }
      const c = s.consumed.get(prior.task);
      if (c === undefined) continue; // still running
      return end(ports, mission, l, 'not-legalized', `the backfill of ${node} did not prove it (${Object.entries(c.verdicts).map(([k, v]) => `${k}: ${v}`).join(', ') || 'no verdict'}; label ${lab.labels[node] ?? 'unknown'})`, [node]);
    }
    if (next === null) return running.length > 0 ? 'node Auditors are running' : `waiting for ${gen.join(', ')}`;
    const node = next;
    const n = s.seq + 1;
    const task = aid.task(mission, l, n, 'node');
    const card = await nodeCard(ctx, req, plan, n, task, node);
    if (card === null) return end(ports, mission, l, 'not-legalized', `${node} has no position an Auditor may fill (5.2 part 3)`, [node]);
    if ('missingBasis' in card) return end(ports, mission, l, 'not-legalized', `the text of ${card.missingBasis} that ${node} must be judged against is not recorded, so no Auditor can judge it honestly (5.2: every basis of the contract, current)`, [node]);
    await submit(ports, mission, l, req, { n, task, kind: 'node', node, positions: card.positions.map((p) => p.review) }, card);
    return null;
  }

  // 5. the chain-acceptance object
  if (s.chain === null) {
    const items = await currentItems(ctx);
    const ix = await basisIndex(ctx);
    const reqset = requirementSetLine(mission);
    const content = ports.ledger.content.put(
      canonicalJson({ format: 'mp4.chain-acceptance.v1', legalization: l, endpoint: plan.endpoint, nodes: plan.chain, words: items.map((i) => i.version).sort(), request: req.words }),
    );
    const object = aid.chainObject(mission, l);
    const contract: ReviewContract = { review: 'auditor-chain', basisLines: ix.current.has(reqset) ? [reqset as never] : [], reliesOn: plan.chain as never };
    const rec: ObjectVersionRecord = {
      kind: 'object.version',
      object: object as ObjectVersionId,
      objectKind: 'chain-acceptance',
      mission,
      module: null,
      content,
      prerequisites: ports.ledger.content.putList([]),
      scope: { paths: [`legalization/${l}`], taskType: 'legalization' },
      reviews: [contract],
    };
    await ports.ledger.append(aid.op(mission, l, 'chain'), { events: [{ mission, line, event: 'chain', key: 'object', body: { object, content } }], records: [rec] });
    return null;
  }

  if (running.some((t) => t.kind === 'node')) return 'node Auditors are running';
  // 6. the chain Auditor
  const chainTask = [...s.tasks.values()].find((t) => t.kind === 'chain');
  if (chainTask === undefined) {
    const n = s.seq + 1;
    const task = aid.task(mission, l, n, 'chain');
    const card = await chainCard(ctx, req, plan, s.chain.object, n, task);
    await submit(ports, mission, l, req, { n, task, kind: 'chain', node: s.chain.object, positions: ['auditor-chain'] }, card);
    return null;
  }
  if (!s.consumed.has(chainTask.task)) return 'the chain Auditor is running';
  const verdict = s.consumed.get(chainTask.task)?.verdicts['auditor-chain'];
  if (verdict !== 'pass') return end(ports, mission, l, 'chain-refused', `the chain Auditor's verdict is ${verdict ?? 'missing'} on ${s.chain.object}: a new legalization makes a new chain object (10.1)`, [s.chain.object]);
  if (!proven(s.chain.object)) return end(ports, mission, l, 'not-legalized', `the chain object ${s.chain.object} is ${lab.labels[s.chain.object] ?? 'unknown'} although its judgment passed (evidence not applicable, or a node changed)`, [s.chain.object]);

  // 7. the stamp (6.1): register the proof-conditioned operation, then execute it as of the
  // published revision TOGETHER with the result event, in one transaction (commitProofOp with
  // events); the PM is told only once both are persisted (advanceLegalization, review r1 #5)
  const op = s.ops.at(-1) ?? null;
  if (op === null) return register(ports, mission, l, req, s.chain.object, 1);
  const st = await ports.evaluator.ops([op]);
  const o = st.states[op];
  if (o === null || o === undefined) return 'the evaluator has not seen the stamp operation yet';
  if (o.executedAsOf !== null) return `the stamp ${op} is executed (as of ${o.executedAsOf}); its result is being read back`;
  if (!o.allProven) return end(ports, mission, l, 'not-legalized', `the stamp's object ${s.chain.object} is no longer all proven at revision ${st.revision}`, [s.chain.object]);
  const stamp = { op, asOf: st.revision, chainObject: s.chain.object, excluded: plan.excluded };
  const result: ResultBody = { outcome: 'stamped', wi: null, why: `stamped as of revision ${st.revision}`, nodes: plan.chain, stamp };
  try {
    // the request op names the attempt (its asOf): a retry at a newer revision is a new request,
    // and the ledger refuses a second execution of the same operation (FACT_CONFLICT)
    await ports.ledger.commitProofOp({ op: aid.op(mission, l, `stamp:${op}:${st.revision}`), opId: op, asOf: st.revision, events: [{ mission, line, event: 'result', key: 'result', body: result }] });
  } catch (e) {
    const code = errCode(e);
    if (code === 'BELOW_FLOOR' || code === 'NOT_READY' || code === 'UNAVAILABLE' || code === 'STALE_GENERATION' || code === 'PAUSED') return `the stamp waits for the next published revision (${code})`;
    if (code === 'STOPPED') return 'a stop restriction covers the stamp (6.4): it waits while the stop holds; nothing is stamped';
    if (code === 'NOT_PENDING' || code === 'EVALUATOR_FAULT') {
      // the ledger ended the operation (derived state could not be computed, 6.1, WI-11): register it again under a new id
      return register(ports, mission, l, req, s.chain.object, s.ops.length + 1);
    }
    if (code === 'FACT_CONFLICT') return `the stamp ${op} was executed by an earlier attempt; its result is read back on the next pass`;
    throw e;
  }
  return null;
}

/** The code of a port error (`code`, or a "CODE: ..." message). */
function errCode(e: unknown): string {
  const c = (e as { code?: unknown } | null)?.code;
  if (typeof c === 'string') return c;
  return /^([A-Z][A-Z_]+):/.exec((e as Error | null)?.message ?? '')?.[1] ?? '';
}

async function register(ports: FlowPorts, mission: MissionId, l: string, req: LegalizationRequest, object: string, k: number): Promise<null> {
  const op = aid.stampOp(mission, l, k);
  await ports.ledger.append(aid.op(mission, l, `op:${k}`), {
    events: [{ mission, line: aid.line(l), event: 'op', key: op, body: { op } }],
    records: [{ kind: 'op.pending', op: op as OpId, opKind: 'legalization', objects: ports.ledger.content.putList([object]), scope: { mission, capabilities: [...req.capabilities] } }],
  });
  return null;
}

/** The result's notice to the PM, once the result is persisted (idempotent by key: sent again after a crash, a no-op). */
async function notifyResult(ports: FlowPorts, mission: MissionId, l: string, s: LegalizationState): Promise<void> {
  const r = s.result;
  if (r === null) return;
  const plan = s.plan;
  if (r.outcome === 'stamped' && r.stamp !== null) {
    await ports.ledger.notify({
      category: 'legalization-stamped',
      wi: null,
      key: l,
      mission,
      trigger: `legalization ${l} of ${plan?.endpoint ?? '?'}: every node of the chain is proven and the chain Auditor passed`,
      defaultAction: `the chain is stamped (operation ${r.stamp.op}, as of revision ${r.stamp.asOf}); a later change to any node or to the chain evidence takes the stamp off and the PM is told`,
      detail: { legalization: l, endpoint: plan?.endpoint ?? null, chain: plan?.chain ?? [], stamp: r.stamp, backfilled: [...s.tasks.values()].filter((t) => t.kind === 'node').map((t) => t.node) },
    });
    return;
  }
  await ports.ledger.notify({
    category: r.outcome === 'refused' ? 'legalization-refused' : r.outcome === 'chain-refused' ? 'legalization-chain-refused' : 'legalization-incomplete',
    wi: WI_LEGALIZATION,
    key: l,
    mission,
    trigger: `legalization ${l}: ${r.why}`,
    defaultAction:
      r.outcome === 'refused'
        ? 'no Auditor was started; nothing else is affected. The negated node must be fixed (rework and a new judgment of the same review kind) or the endpoint changed, then a new legalization can be asked for'
        : 'no further Auditor is started and nothing is stamped; the judgments already made stay recorded (they count for the nodes they proved); nothing else is affected',
    detail: { legalization: l, outcome: r.outcome, nodes: r.nodes, ...(r.outcome === 'refused' && plan !== null ? { blocked: plan.blocked } : {}) },
    askUser: true,
  });
}

async function end(ports: FlowPorts, mission: MissionId, l: string, outcome: LegalizationOutcome, why: string, nodes: readonly string[]): Promise<null> {
  const result: ResultBody = { outcome, wi: WI_LEGALIZATION, why, nodes, stamp: null };
  await ports.ledger.append(aid.op(mission, l, 'result'), { events: [{ mission, line: aid.line(l), event: 'result', key: 'result', body: result }] });
  return null; // advanceLegalization tells the PM once the result is read back
}

function consumption(q: QueuedBody, st: FlowTaskStatus): ConsumedBody | null {
  if (st.state === 'abandoned') return { task: q.task, kind: 'abandoned', node: q.node, verdicts: {}, judgments: [] };
  if (st.state !== 'done' || st.handBack === null || st.handBack.status !== 'handed-back') return null;
  const judgments = st.handBack.records.filter((r): r is JudgmentRecord => r.kind === 'judgment').map((r) => r.judgment as string);
  if (q.kind === 'chain') return { task: q.task, kind: 'chain', node: q.node, verdicts: { 'auditor-chain': (st.handBack.result as AuditChainResult).verdict }, judgments };
  const r = st.handBack.result as AuditNodeResult;
  return { task: q.task, kind: 'node', node: q.node, verdicts: Object.fromEntries(r.positions.map((p) => [p.review, p.verdict])), judgments };
}

function taskOf(req: LegalizationRequest, task: string, card: AnyCard) {
  return { task, lineage: aid.lineage(req.mission, req.legalization), mission: req.mission as MissionId, card, priority: 50, capabilities: [...new Set([...SEAT_CAPABILITIES, ...req.capabilities])], mode: 'fast' as const, estimateMicros: 0 };
}

async function submit(ports: FlowPorts, mission: MissionId, l: string, req: LegalizationRequest, q: Omit<QueuedBody, 'card'>, card: AuditNodeCard | AuditChainCard): Promise<void> {
  const any = card as unknown as AnyCard;
  const hash = ports.ledger.content.put(canonicalJson(any));
  await ports.scheduler.submit(taskOf(req, q.task, any));
  await ports.ledger.append(aid.op(mission, l, `queue:${q.n}`), { events: [{ mission, line: aid.line(l), event: 'queued', key: String(q.n), body: { ...q, card: hash } }] });
}

// ---------------------------------------------------------------- cards

const LIMITS = { run: { memoryMax: 1 << 30, timeoutMs: 30 * 60_000 }, areaBytes: 256 << 20, export: { maxLogicalBytes: 32 << 20, maxFiles: 2_000 }, recoveryStateBytes: 0 };

function base(req: LegalizationRequest, task: string, duties: string) {
  return {
    format: 'mp4.seat-card.v1' as const,
    launch: task,
    mission: req.mission,
    module: null,
    capabilities: [...new Set([...SEAT_CAPABILITIES, ...req.capabilities])],
    duties,
    decisionQuotes: [],
    constraints: [],
    limits: LIMITS,
  };
}

function materialOf(ctx: FlowCtx, id: string, title: string, hash: string): MaterialRef | null {
  try {
    const doc = ctx.ports.ledger.content.get(hash);
    return { id, title, ref: hash, pages: materialPageCount(doc), mustRead: false };
  } catch {
    return null;
  }
}

/**
 * Evidence the Auditor may cite (11.1 "封闭运行可复用，其余按 7.3 重跑"): the runs the existing
 * judgments on these targets used, plus the given ones, that still apply (bound to the current
 * snapshot of their environment line and not revoked, 5.2). A run that needs a rerun is left off:
 * citing it would make the Auditor's own judgment not current.
 */
async function evidenceFor(ctx: FlowCtx, targets: ReadonlySet<string>, extra: readonly string[]): Promise<Array<{ id: string; command: string; summary: string }>> {
  const ids = new Set<string>(extra);
  for (const c of await ctx.ports.ledger.records(['judgment'])) if (targets.has(c.record.target)) for (const e of ctx.ports.ledger.content.getList(c.record.evidence)) ids.add(e);
  const recs = new Map((await ctx.ports.ledger.records(['evidence'])).map((c) => [c.record.evidence as string, c.record as EvidenceRecord]));
  const envCurrent = new Map<string, string>();
  for (const c of await ctx.ports.ledger.records(['env.snapshot'])) envCurrent.set(c.record.line, c.record.snapshot);
  const revoked = new Set((await ctx.ports.ledger.records(['evidence.revoked'])).map((c) => c.record.evidence as string));
  return [...ids].sort().flatMap((id) => {
    const r = recs.get(id);
    if (r === undefined || revoked.has(id) || envCurrent.get(r.envLine) !== r.envSnapshot) return [];
    const f = Object.entries(r.fields).slice(0, 6).map(([k, v]) => `${k}=${v.length > 60 ? `${v.slice(0, 57)}...` : v}`);
    return [{ id, command: r.fields['command'] ?? '(recorded run)', summary: `${r.runClass} run: ${f.join(', ')}` }];
  });
}

/**
 * The text of every basis line the flows record (review r1 #3: an Auditor judges the current
 * text, never a placeholder): requirement items (with the user's words), task standards (from the
 * effective detailed plans), the mission's requirement set (expanded to the items it holds), and
 * exploration definitions (the user's acceptance goal). A line with no known text is missing.
 */
async function basisTexts(ctx: FlowCtx): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const itemsByVersion = new Map<string, { line: string; type: string; text: string; quote: string | null }>();
  for (const e of await ctx.ports.ledger.events<ItemVersionBody>({ mission: ctx.mission, line: REQUIREMENTS_LINE, event: 'item' })) {
    itemsByVersion.set(e.body.version, { line: e.body.line, type: e.body.type, text: e.body.text, quote: e.body.source.kind === 'words' ? e.body.source.quote : null });
  }
  for (const i of await currentItems(ctx)) out.set(i.line, `${i.type}: ${i.text}${i.source.kind === 'words' ? ` — the user's words: "${i.source.quote}"` : ''}`);
  for (const e of await ctx.ports.ledger.events<EffectiveBody>({ mission: ctx.mission, line: PLAN_LINE, event: 'effective' })) {
    const d = await detailedPlanOf(ctx, e.body.dplan);
    if (d === null) continue;
    for (const t of d.plan.tasks) for (const st of t.standards) out.set(standardLine(ctx.mission, t.id, st.id), `acceptance standard ${st.id} of task ${t.id}: ${st.text}`);
  }
  const ix = await basisIndex(ctx);
  const reqset = requirementSetLine(ctx.mission);
  const v = ix.current.get(reqset);
  const rec = v !== undefined ? ix.records.get(v) : undefined;
  if (rec !== undefined && rec.basisKind === 'requirement-set') {
    const members = ctx.ports.ledger.content.getList(rec.snapshot).map((iv) => itemsByVersion.get(iv));
    if (members.every((m) => m !== undefined)) {
      out.set(reqset, `the mission's requirement set (${members.length} item(s) in force): ${members.map((m) => `[${m?.line}] ${m?.type}: ${m?.text}${m?.quote !== null && m?.quote !== undefined ? ` ("${m.quote}")` : ''}`).join('; ')}`);
    }
  }
  for (const e of await ctx.ports.ledger.events<{ definition: { goal: string; exploration: string }; basisLine?: string }>({ mission: ctx.mission, event: 'defined' })) {
    if (!e.line.startsWith('exploration:') || e.body.basisLine === undefined) continue;
    const re = (await ctx.ports.ledger.events<{ definition: { goal: string } }>({ mission: ctx.mission, line: e.line, event: 'redefined' })).at(-1);
    out.set(e.body.basisLine, `the definition of exploration ${e.body.definition.exploration}; the user's acceptance goal, verbatim: "${(re?.body.definition ?? e.body.definition).goal}"`);
  }
  return out;
}

/** The plan task whose accepted product is this object (execution's "accepted" events), with its verification commands. */
async function taskOfProduct(ctx: FlowCtx, object: string): Promise<{ readonly task: string; readonly commands: ReadonlyArray<{ id: string; command: string; cwd?: string }> } | null> {
  for (const e of await ctx.ports.ledger.events<{ product?: string }>({ mission: ctx.mission, event: 'accepted' })) {
    if (e.body.product !== object || !e.line.startsWith('task:')) continue;
    const task = e.line.slice('task:'.length);
    let commands: Array<{ id: string; command: string; cwd?: string }> = [];
    for (const f of await ctx.ports.ledger.events<EffectiveBody>({ mission: ctx.mission, line: PLAN_LINE, event: 'effective' })) {
      const d = await detailedPlanOf(ctx, f.body.dplan);
      const t = d?.plan.tasks.find((x) => x.id === task);
      if (t !== undefined) commands = t.verificationCommands.map((c) => ({ id: c.id, command: c.command, ...(c.cwd !== undefined ? { cwd: c.cwd } : {}) }));
    }
    return { task, commands };
  }
  return null;
}

/**
 * The snapshot an Auditor reads (review r1 #3): the bound content itself. A product version is
 * read at its own commit; several products (a proof unit's members, the whole chain) are laid
 * over the endpoint's commit; documents (plans, interpretations) are materials.
 */
async function auditSnapshot(ctx: FlowCtx, l: string, purpose: string, objects: readonly ObjectVersionRecord[], endpointCommit: string | null): Promise<string> {
  const products = objects.filter((o) => o.objectKind === 'product' && o.source !== undefined);
  const req =
    products.length === 1 && objects.length === 1
      ? { mission: ctx.mission, purpose, commit: (products[0] as ObjectVersionRecord & { source: { commit: string } }).source.commit }
      : { mission: ctx.mission, purpose, ...(endpointCommit !== null ? { commit: endpointCommit } : {}), ...(products.length > 0 ? { products: products.map((o) => o.object as string) } : {}) };
  void l;
  return (await ctx.ports.scheduler.snapshot(req)).path;
}

/** Documents of non-product objects as materials (a product's content is its snapshot, not its tree manifest). */
function contentMaterials(ctx: FlowCtx, objects: readonly ObjectVersionRecord[]): MaterialRef[] {
  const out: MaterialRef[] = [];
  objects.forEach((o, i) => {
    if (o.objectKind === 'product') return;
    const m = materialOf(ctx, objects.length === 1 ? 'content' : `content-${i + 1}`, `The content of ${o.object} (${o.objectKind})`, o.content);
    if (m !== null) out.push({ ...m, mustRead: true });
  });
  return out;
}

/** The node Auditor's card: the positions it may fill (5.2 part 3), each with its contract's inputs. */
async function nodeCard(ctx: FlowCtx, req: LegalizationRequest, plan: PlanBody, n: number, task: string, node: string): Promise<AuditNodeCard | { readonly missingBasis: string } | null> {
  const ports = ctx.ports;
  const objects = new Map((await ports.ledger.records(['object.version'])).map((c) => [c.record.object as string, c.record as ObjectVersionRecord]));
  const units = new Map((await ports.ledger.records(['proof.unit'])).map((c) => [c.record.unit as string, c.record as ProofUnitRecord]));
  const obj = objects.get(node);
  const unit = units.get(node);
  const contracts = obj?.reviews ?? unit?.reviews ?? [];
  if (contracts.length === 0) return null;
  const view = (await ports.evaluator.deciding([node])).views[node] ?? null;
  const by = (view?.positions ?? []).flatMap((p) => (p.by !== null ? [p.by as string] : []));
  const current = by.length > 0 ? (await ports.evaluator.judgments(by)).current : {};
  const ix = await basisIndex(ctx);
  const texts = await basisTexts(ctx);
  const constraints = (await currentConstraints(ctx)).filter((k) => k.kind === 'object');
  const label = (await ports.evaluator.labels([node])).labels[node] ?? 'unknown';
  const eligible: Array<{ contract: ReviewContract; reason: AuditPositionT['reason']; prior: string | null }> = [];
  for (const c of contracts) {
    const p = view?.positions.find((x) => x.review === c.review);
    const state = p?.state ?? 'none';
    if (state === 'none') eligible.push({ contract: c, reason: 'missing', prior: null });
    else if (state === 'undecided') eligible.push({ contract: c, reason: 'undecided', prior: p?.by ?? null });
    else if (state === 'pass' && p?.by != null && current[p.by] !== true) eligible.push({ contract: c, reason: 'not-current', prior: p.by });
    else if (state === 'fail') return null; // negated: never backfilled (5.2)
  }
  if (eligible.length === 0 && label === 'not-fully-proven') {
    // every position is in effect and the parents are proven: only coverage is missing; a full
    // review of one position covers every constraint path (5.2 v34: not a continuation)
    const c = contracts[0] as ReviewContract;
    eligible.push({ contract: c, reason: 'coverage', prior: view?.positions.find((x) => x.review === c.review)?.by ?? null });
  }
  if (eligible.length === 0) return null;
  const scopeObj = obj?.scope ?? null;
  const applying = scopeObj === null ? [] : constraints.filter((k) => constraintApplies(k.scope, scopeObj)).map((k) => ({ k, paths: requiredRange(k.scope, scopeObj) })).filter((x) => x.paths.length > 0);
  const content = ports.ledger.content;
  const positions: AuditPositionT[] = [];
  let i = 0;
  for (const e of eligible) {
    i++;
    const bases: Array<{ id: string; text: string }> = [];
    const versions: string[] = [];
    for (const line of e.contract.basisLines) {
      const v = ix.current.get(line);
      if (v === undefined || ix.withdrawn.has(line)) return null; // a withdrawn basis cannot be bound (the node shows "basis withdrawn")
      versions.push(v);
      const text = texts.get(line);
      // no placeholder: an Auditor judging a basis it cannot read would prove nothing (review r1 #3)
      if (text === undefined) return { missingBasis: line };
      bases.push({ id: line, text: `${text} (version ${v})` });
    }
    if (bases.length === 0) bases.push({ id: 'contract', text: `the contract of position "${e.contract.review}" names no basis item: judge the node against its stated purpose and the objects it relies on` });
    positions.push({
      review: e.contract.review,
      reason: e.reason,
      bases,
      constraints: applying.map((x) => ({ id: x.k.line, version: x.k.version, text: x.k.text, paths: x.paths })),
      prior: e.prior,
      inheritedEvidence: [],
      binding: {
        judgment: aid.judgment(req.mission, req.legalization, n, i),
        bases: content.putList([...new Set(versions)].sort()),
        constraints: content.putList(applying.map((x) => encodeConstraintCheck({ version: x.k.version, paths: x.paths })).sort()),
        reliesOn: content.putList([...new Set(e.contract.reliesOn as readonly string[])].sort()),
        revokes: null,
        extends: null,
        evidenceUse: { fields: ['exit'], statisticalOrExternal: false },
        superseded: [],
      },
    });
  }
  const members = unit !== undefined ? content.getList(unit.members) : [];
  const memberObjects = members.flatMap((m) => (objects.get(m) !== undefined ? [objects.get(m) as ObjectVersionRecord] : []));
  if (unit !== undefined && memberObjects.length !== members.length) return { missingBasis: `members of ${node}` };
  const bound = obj !== undefined ? [obj] : memberObjects;
  const snapshot = await auditSnapshot(ctx, req.legalization, `legalization-${req.legalization}-n${n}`, bound, null);
  const materials = contentMaterials(ctx, bound);
  const commands = obj !== undefined && obj.objectKind === 'product' ? ((await taskOfProduct(ctx, obj.object))?.commands ?? []) : [];
  const pn = plan.nodes.find((x) => x.id === node);
  return {
    ...base(req, task, 'Fill the listed review positions of this node, independently, against their contracts.'),
    seat: 'auditor-node',
    workspace: { snapshot, writablePaths: [], scratchPaths: commands.length > 0 ? ['.'] : [] },
    legalization: req.legalization,
    target: {
      id: node,
      kind: unit !== undefined ? 'unit' : 'object',
      objectKind: pn?.objectKind ?? obj?.objectKind ?? 'proof-unit',
      label,
      boundary: contracts.length === 1 && contracts[0]?.review === 'auditor',
      paths: [...new Set(bound.flatMap((o) => o.scope.paths))],
    },
    positions,
    evidence: await evidenceFor(ctx, new Set([node, ...members]), []),
    // the task's verification commands, which the Auditor may have the program rerun (7.3)
    declaredCommands: [...commands],
    materials,
  };
}

/** The chain Auditor's card (11.1): the user's words, the seams of the chain, the chain evidence. */
async function chainCard(ctx: FlowCtx, req: LegalizationRequest, plan: PlanBody, object: string, n: number, task: string): Promise<AuditChainCard> {
  const items = await currentItems(ctx);
  const ix = await basisIndex(ctx);
  const reqset = requirementSetLine(req.mission);
  const words = items.filter((i) => i.source.kind === 'words');
  const quotes = (words.length > 0 ? words : items).map((i) => ({ id: i.line, text: i.source.kind === 'words' ? `"${i.source.quote}" (${i.type}: ${i.text})` : `${i.type}: ${i.text}` }));
  if (quotes.length === 0) quotes.push({ id: 'request', text: `(no requirement item is recorded) the user's request: "${req.words}"` });
  const chain = new Set(plan.chain);
  const seams: Array<{ id: string; between: string[]; text: string }> = [];
  // every required edge inside the chain is a seam; none is dropped (review r1 #4): the card lists
  // the first ones, the complete table is a must-read material
  for (const node of plan.nodes) for (const p of node.parents) if (chain.has(p)) seams.push({ id: `seam-${seams.length + 1}`, between: [node.id, p], text: `${node.id} relies on ${p}: what one provides is what the other uses` });
  const content = ctx.ports.ledger.content;
  const v = ix.current.get(reqset);
  // the actual candidate (review r1 #3): every product of the chain laid over the endpoint's commit, documents as materials
  const objects = new Map((await ctx.ports.ledger.records(['object.version'])).map((c) => [c.record.object as string, c.record as ObjectVersionRecord]));
  const units = new Map((await ctx.ports.ledger.records(['proof.unit'])).map((c) => [c.record.unit as string, c.record as ProofUnitRecord]));
  const bound = plan.chain.flatMap((id) => {
    const u = units.get(id);
    const ids = u !== undefined ? content.getList(u.members) : [id];
    return ids.flatMap((m) => (objects.get(m) !== undefined ? [objects.get(m) as ObjectVersionRecord] : []));
  });
  const end = objects.get(plan.endpoint);
  const snapshot = await auditSnapshot(ctx, req.legalization, `legalization-${req.legalization}-chain`, bound, end?.source?.commit ?? null);
  const materials: MaterialRef[] = [...contentMaterials(ctx, bound)];
  if (seams.length > SEAMS_ON_CARD) {
    const table = seamTable(seams);
    materials.push({ id: 'seams', title: `The complete seam table (${seams.length} seams)`, ref: content.put(table), pages: materialPageCount(table), mustRead: true });
  }
  return {
    ...base(req, task, 'Judge the whole chain: the user\'s words honoured by the endpoint, and every seam.'),
    seat: 'auditor-chain',
    workspace: { snapshot, writablePaths: [], scratchPaths: [] },
    legalization: req.legalization,
    chain: { object, endpoint: plan.endpoint, nodes: plan.nodes.map((x) => ({ id: x.id, kind: x.objectKind, label: 'proven' })), excluded: [...plan.excluded] },
    quotes,
    seams,
    evidence: await evidenceFor(ctx, new Set<string>(), req.chainEvidence),
    declaredCommands: [],
    materials,
    binding: {
      judgment: aid.chainJudgment(req.mission, req.legalization, n),
      bases: content.putList(v !== undefined && !ix.withdrawn.has(reqset) ? [v] : []),
      constraints: content.putList([]),
      reliesOn: content.putList([...plan.chain].sort()),
      revokes: null,
      extends: null,
      evidenceUse: { fields: ['exit'], statisticalOrExternal: false },
      superseded: [],
    },
  };
}

