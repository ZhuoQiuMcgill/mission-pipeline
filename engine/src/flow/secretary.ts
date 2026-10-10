// Escalations to the Secretary (design 3.8, 3.2, 3.9, 6.5) for every flow.
//
// A flow raises an escalation with the options the program can carry out for it; this module
// starts one fresh Secretary task per escalation (in the lineage it handles, so its invocation
// counts toward that lineage, 6.5), records the decision, and tells the PM by 3.2:
//   detail                       recorded only (layer 2; "may matter" noted when set)
//   important-within-authority   takes effect; the PM is told (a Secretary notice, 3.9)
//   needs-user                   the related work waits; the PM is told and asks the user; the
//                                PM records the user's answer with answerEscalation()
// The owning flow reads the decision (decisionFor) and carries it out mechanically, then marks
// it applied (markApplied), so a restarted flow neither loses nor repeats it.
//
// Edge cases take the safe default with a notice (maintainer 2026-10-09): a Secretary that
// cannot decide (its seat failed, or its task is exhausted) hands the decision to the PM and the
// user (proposed WI-24); a Secretary grant the ledger refuses (its one grant on the lineage is
// used) asks the user (WI-08).

import type { JudgmentId, MissionId, ObjectVersionId } from '../common/ids.ts';
import type { JudgmentRecord, ListRef } from '../common/records.ts';
import { validateRecord } from '../common/validate.ts';
import type { CardBinding } from '../seat/cards/common.ts';
import type { DecisionOption, EscalationSource, SecretaryCard, SecretaryResult } from '../seat/cards/secretary.ts';
import { cardBase, commit, currentVersions, basisIndex, defaultLimits, ev, eventOf, eventsOf, flowCtx, judgmentRecordOf, material, safeId, taskView, tellOnce, type FlowCtx } from './context.ts';
import { PLAN_LINE, SECRETARY_LINE } from './plandoc.ts';
import type { FlowEventInput, FlowPorts } from './ports.ts';
import { currentItems } from './requirements.ts';
import { WI } from './wi.ts';

export interface EscalationSpec {
  /** Deterministic and unique within the mission (safeId applied). */
  readonly id: string;
  readonly source: EscalationSource;
  readonly lineage: string;
  /** What it is about, e.g. "plan:<object>" or "task:<id>". */
  readonly subject: string;
  readonly summary: string;
  readonly original?: string;
  readonly changed?: string;
  readonly reasons: readonly string[];
  readonly options: readonly DecisionOption[];
  /** Requirement item lines involved. */
  readonly items?: readonly string[];
  /** A negated review position the decision rules on (accept → a pass revoking the negation). */
  readonly position?: { readonly target: string; readonly review: string; readonly revokes: string } | null;
  /** Facts for the Secretary (and for the owning flow when it applies the decision). */
  readonly facts?: unknown;
}

export interface EscalationBody extends EscalationSpec {
  readonly task: string;
}

export interface DecisionBody {
  readonly escalation: string;
  readonly by: 'secretary' | 'user' | 'program';
  readonly option: DecisionOption;
  readonly classification: 'detail' | 'important-within-authority' | 'needs-user';
  readonly authorization: string | null;
  readonly reason: string;
  readonly instructions: string;
  readonly grantExtra: number;
  readonly notice: string;
  readonly mayMatter: boolean;
}

/** What an option means, for the card. */
const OPTION_TEXT: Readonly<Record<DecisionOption, { label: string; outcome: string }>> = {
  accept: { label: 'Accept as it is', outcome: 'the item stands; the work goes on (a negated review position is overruled by your ruling)' },
  'accept-risk': { label: 'Accept the remaining risk', outcome: 'the unresolved items go to the risk list; the work goes on' },
  'send-back': { label: 'Send back with instructions', outcome: 'the Architect revises the plan per your instructions (counted with the plan returns)' },
  replan: { label: 'Re-plan', outcome: 'the Architect decomposes again with your instructions (split the task, change the approach)' },
  grant: { label: 'Grant 1 or 2 more attempts (your one grant on this lineage)', outcome: 'the exhausted loop runs again; after that only the user can grant more' },
  restart: { label: 'Restart the seat', outcome: 'the task is dispatched again (counted with the restarts after quarantine or seat failure, cap 2)' },
  abandon: { label: 'Give the task up', outcome: 'the task stops and goes to the risk list; the rest of the mission continues' },
  answer: { label: 'Answer the question', outcome: 'your answer goes to the seat as a decision; the work goes on' },
  rework: { label: 'Send back to the Constructor', outcome: 'the Constructor reworks per your instructions (counted with the reworks)' },
  'ask-user': { label: 'Ask the user', outcome: 'the related work waits; the PM asks the user' },
};

export const escalationTask = (id: string): string => `sec.${id}`;

export async function escalation(ctx: FlowCtx, id: string): Promise<EscalationBody | null> {
  return (await eventOf<EscalationBody>(ctx, SECRETARY_LINE, 'escalation', id))?.body ?? null;
}

/** The escalations of a subject, oldest first. */
export async function escalationsOf(ctx: FlowCtx, subject: string): Promise<EscalationBody[]> {
  return (await eventsOf<EscalationBody>(ctx, SECRETARY_LINE, 'escalation')).filter((e) => e.body.subject === subject).map((e) => e.body);
}

/** Raise an escalation (idempotent by id): the event, then the Secretary task. */
export async function raiseEscalation(ctx: FlowCtx, spec: EscalationSpec): Promise<void> {
  const id = safeId(spec.id);
  if ((await escalation(ctx, id)) !== null) return;
  const body: EscalationBody = { ...spec, id, task: escalationTask(id) };
  await commit(ctx, `flow:escalation:${ctx.mission}:${id}`, { events: [ev(ctx, SECRETARY_LINE, 'escalation', id, body)] });
  await submitSecretary(ctx, body);
}

async function submitSecretary(ctx: FlowCtx, e: EscalationBody): Promise<void> {
  if ((await ctx.ports.scheduler.status(e.task)) !== null) return;
  const card = await secretaryCard(ctx, e);
  await ctx.ports.scheduler.submit({
    task: e.task,
    lineage: e.lineage,
    mission: ctx.mission,
    card,
    priority: 120,
    capabilities: card.capabilities,
    mode: 'fast',
    estimateMicros: 200_000,
    secretaryFor: e.lineage,
  });
  ctx.progressed = true;
}

async function secretaryCard(ctx: FlowCtx, e: EscalationBody): Promise<SecretaryCard> {
  const items = await currentItems(ctx);
  const auths = items.filter((i) => i.type === 'authorization');
  const involved = items.filter((i) => (e.items ?? []).includes(i.line) || i.type === 'decision');
  const grantAvailable = !(await ctx.ports.ledger.loop(e.lineage, 'env-retry')).secretaryGrantUsed;
  const batches = await eventsOf<{ batch: string; userWords: string[]; summary?: string }>(ctx, PLAN_LINE, 'pm-batch');
  const request = [
    `Escalation ${e.id} from ${e.source} on ${e.subject}`,
    e.summary,
    e.original ? `Original:\n${e.original}` : '',
    e.changed ? `Changed:\n${e.changed}` : '',
    e.reasons.length > 0 ? `Reasons:\n${e.reasons.map((r) => `- ${r}`).join('\n')}` : '',
    e.facts !== undefined ? `Facts:\n${JSON.stringify(e.facts, null, 2)}` : '',
  ]
    .filter((s) => s !== '')
    .join('\n\n');
  let position: SecretaryCard['position'] = null;
  if (e.position) {
    const neg = await judgmentRecordOf(ctx, e.position.revokes);
    if (neg !== null) position = { target: e.position.target, review: e.position.review, revokes: e.position.revokes, binding: rulingBinding(neg, `j.sec.${e.id}`) };
  }
  return {
    ...cardBase(ctx, e.task, {
      duties: 'Decide this one escalation within the recorded authority, pick one option, classify it, and write the notice for the PM.',
      decisionQuotes: involved.filter((i) => i.type === 'decision').map((i) => i.text),
      limits: defaultLimits('materials'),
    }),
    seat: 'secretary',
    request: { id: e.id, source: e.source, lineage: e.lineage, subject: e.subject, summary: e.summary, original: e.original ?? '', changed: e.changed ?? '', reasons: [...e.reasons] },
    authorizations: auths.map((a) => ({ id: a.line, quote: a.source.kind === 'words' ? a.source.quote : a.text, notifyCondition: a.notifyCondition })),
    items: involved.map((i) => ({ id: i.line, text: i.text })),
    materials: [
      material(ctx, 'request', 'The escalated question and its facts', request, true, 'record'),
      material(ctx, 'authorizations', 'Authorizations in force (verbatim)', auths.map((a) => `[${a.line}] ${a.text}${a.source.kind === 'words' ? ` — "${a.source.quote}"` : ''}`).join('\n') || '(none)', true, 'authorizations'),
      material(ctx, 'alignment', 'Alignment record (PM batches)', batches.map((b) => `${b.key}: user messages ${b.body.userWords.join(', ') || 'none'}`).join('\n') || '(none)', true, 'record'),
    ],
    options: e.options.map((o) => ({ id: o, ...OPTION_TEXT[o] })),
    grantAvailable,
    position,
  };
}

/** A ruling's binding: the same contract inputs as the negation it overrules. */
function rulingBinding(neg: JudgmentRecord, judgment: string): CardBinding {
  return {
    judgment,
    bases: neg.bases,
    constraints: neg.constraints,
    reliesOn: neg.reliesOn,
    evidence: neg.evidence,
    revokes: neg.judgment,
    extends: null,
    evidenceUse: { fields: [...neg.evidenceUse.fields], statisticalOrExternal: neg.evidenceUse.statisticalOrExternal },
    superseded: [],
  };
}

/** Process every open escalation of the mission: start its Secretary, record its decision, tell the PM. */
export async function secretaryStep(ctx: FlowCtx): Promise<void> {
  for (const e of await eventsOf<EscalationBody>(ctx, SECRETARY_LINE, 'escalation')) {
    const esc = e.body;
    const decided = await eventOf<DecisionBody>(ctx, SECRETARY_LINE, 'decision', esc.id);
    if (decided !== null) {
      // the notices a decision calls for are sent until marked told (code review r1 #14)
      if (decided.body.by === 'program') await tellUndecided(ctx, esc, decided.body.reason);
      else await tellPm(ctx, esc, decided.body);
      const toUser = await eventOf<{ why: string; wi: string | null }>(ctx, SECRETARY_LINE, 'to-user', esc.id);
      if (toUser !== null && (await eventOf(ctx, SECRETARY_LINE, 'user-answer', esc.id)) === null) await tellToUser(ctx, esc.id, toUser.body.why, toUser.body.wi ?? null);
      continue;
    }
    const view = await taskView(ctx, esc.task);
    if (view.kind === 'absent') {
      await submitSecretary(ctx, esc);
      continue;
    }
    if (view.kind === 'pending' || view.kind === 'evidence') continue;
    if (view.kind === 'failed') {
      // the Secretary could not decide: the decision goes to the PM and the user (proposed WI-24)
      const d: DecisionBody = {
        escalation: esc.id,
        by: 'program',
        option: 'ask-user',
        classification: 'needs-user',
        authorization: null,
        reason: `the Secretary seat could not decide (${view.why}: ${view.status.note ?? ''})`,
        instructions: '',
        grantExtra: 0,
        notice: `The Secretary could not decide escalation ${esc.id} (${esc.summary}); please decide with the user.`,
        mayMatter: false,
      };
      await commit(ctx, `flow:decision:${ctx.mission}:${esc.id}`, { events: [ev(ctx, SECRETARY_LINE, 'decision', esc.id, d)] });
      await tellUndecided(ctx, esc, d.reason);
      continue;
    }
    const r = view.result as SecretaryResult;
    const d: DecisionBody = {
      escalation: esc.id,
      by: 'secretary',
      option: r.option,
      classification: r.classification,
      authorization: r.authorization,
      reason: r.reason,
      instructions: r.instructions,
      grantExtra: r.grantExtra,
      notice: r.notice,
      mayMatter: r.mayMatter,
    };
    await commit(ctx, `flow:decision:${ctx.mission}:${esc.id}`, { events: [ev(ctx, SECRETARY_LINE, 'decision', esc.id, d)] });
    await tellPm(ctx, esc, d);
  }
}

async function tellUndecided(ctx: FlowCtx, esc: EscalationBody, why: string): Promise<void> {
  await tellOnce(ctx, SECRETARY_LINE, {
    category: 'secretary-undecided',
    wi: WI.secretaryUndecided,
    key: esc.id,
    trigger: `the Secretary task ${esc.task} for escalation ${esc.id} (${esc.source} on ${esc.subject}) ended without a decision: ${why}`,
    defaultAction: `only ${esc.subject} waits; the decision is handed to the PM and the user (options: ${esc.options.join(', ')}); the rest of the mission continues`,
    detail: { escalation: esc, why },
    askUser: true,
  });
}

/** 3.2, 3.9: detail → layer 2 only; important within authority → a Secretary notice; needs user → the PM asks. */
async function tellPm(ctx: FlowCtx, esc: EscalationBody, d: DecisionBody): Promise<void> {
  if (d.classification === 'detail' || d.by === 'user') return;
  const needsUser = d.classification === 'needs-user';
  await tellOnce(ctx, SECRETARY_LINE, {
    category: needsUser ? 'needs-user-decision' : 'secretary-decision',
    wi: null,
    key: esc.id,
    trigger: `${esc.source} on ${esc.subject}: ${esc.summary}`,
    defaultAction: needsUser ? `only ${esc.subject} waits for the user's decision; the rest of the mission continues` : `decided within authority ${d.authorization ?? ''}: ${d.option}; in effect`,
    detail: { escalation: esc.id, notice: d.notice, option: d.option, reason: d.reason, options: esc.options, authorization: d.authorization },
    ...(needsUser ? { askUser: true } : {}),
  });
}

/** Hand a decided escalation to the user (e.g. the Secretary's grant was refused, WI-08). */
export async function escalateToUser(ctx: FlowCtx, id: string, why: string, wi: string | null): Promise<void> {
  if ((await eventOf(ctx, SECRETARY_LINE, 'to-user', id)) === null) await commit(ctx, `flow:to-user:${ctx.mission}:${id}`, { events: [ev(ctx, SECRETARY_LINE, 'to-user', id, { why, wi })] });
  await tellToUser(ctx, id, why, wi);
}

async function tellToUser(ctx: FlowCtx, id: string, why: string, wi: string | null): Promise<void> {
  const esc = await escalation(ctx, id);
  await tellOnce(ctx, SECRETARY_LINE, {
    category: wi === null ? 'needs-user-decision' : 'loop-exhausted-needs-user',
    wi,
    key: `${id}:to-user`,
    trigger: why,
    defaultAction: `only ${esc?.subject ?? id} waits for the user's decision; the rest of the mission continues`,
    detail: { escalation: id, options: esc?.options ?? [] },
    askUser: true,
  });
}

/**
 * The decision to carry out, or null while there is none (no decision yet, or waiting for the
 * user). A user's answer, once recorded, overrides.
 */
export async function decisionFor(ctx: FlowCtx, id: string): Promise<DecisionBody | null> {
  const answer = await eventOf<DecisionBody>(ctx, SECRETARY_LINE, 'user-answer', id);
  if (answer !== null) return answer.body;
  if ((await eventOf(ctx, SECRETARY_LINE, 'to-user', id)) !== null) return null;
  const d = await eventOf<DecisionBody>(ctx, SECRETARY_LINE, 'decision', id);
  if (d === null || d.body.classification === 'needs-user') return null;
  return d.body;
}

export async function isApplied(ctx: FlowCtx, id: string): Promise<boolean> {
  return (await eventOf(ctx, SECRETARY_LINE, 'applied', id)) !== null;
}

/** The "applied" event of an escalation, to commit atomically with the effect that carries it out (code review r1 #13). */
export function appliedEvent(ctx: FlowCtx, id: string, what: unknown): FlowEventInput {
  return ev(ctx, SECRETARY_LINE, 'applied', id, { what });
}

export async function markApplied(ctx: FlowCtx, id: string, what: unknown): Promise<void> {
  if (await isApplied(ctx, id)) return; // already carried out: not progress
  await commit(ctx, `flow:applied:${ctx.mission}:${id}`, { events: [ev(ctx, SECRETARY_LINE, 'applied', id, { what })] });
}

/** Open escalations of a subject: raised and not applied yet. */
export async function openEscalations(ctx: FlowCtx, subject: string): Promise<EscalationBody[]> {
  const out: EscalationBody[] = [];
  for (const e of await escalationsOf(ctx, subject)) if (!(await isApplied(ctx, e.id))) out.push(e);
  return out;
}

/**
 * The PM records the user's decision on an escalation that needs the user (3.2, 3.9). Accepting
 * a negated position records the user's ruling as a pass that revokes the negation (8.1).
 */
export async function answerEscalation(
  ports: FlowPorts,
  req: { readonly mission: MissionId; readonly escalation: string; readonly option: DecisionOption; readonly instructions?: string; readonly grantExtra?: number; readonly words: string },
): Promise<void> {
  const ctx = flowCtx(ports, req.mission);
  const esc = await escalation(ctx, req.escalation);
  if (esc === null) throw new Error(`no escalation ${req.escalation} in mission ${req.mission}`);
  if (req.option === 'ask-user' || !esc.options.includes(req.option)) throw new Error(`option ${req.option} is not a decision for ${req.escalation} (choose one of ${esc.options.filter((o) => o !== 'ask-user').join(', ')})`);
  const d: DecisionBody = {
    escalation: esc.id,
    by: 'user',
    option: req.option,
    classification: 'important-within-authority',
    authorization: null,
    reason: req.words,
    instructions: req.instructions ?? '',
    grantExtra: req.grantExtra ?? 0,
    notice: '',
    mayMatter: false,
  };
  const records: JudgmentRecord[] = [];
  if ((req.option === 'accept' || req.option === 'accept-risk') && esc.position) {
    const neg = await judgmentRecordOf(ctx, esc.position.revokes);
    if (neg !== null) {
      const b = rulingBinding(neg, `j.user.${esc.id}`);
      const rec: JudgmentRecord = {
        kind: 'judgment',
        judgment: b.judgment as JudgmentId,
        review: esc.position.review,
        executor: 'user',
        target: esc.position.target as ObjectVersionId,
        verdict: 'pass',
        evidence: b.evidence as ListRef,
        bases: b.bases as ListRef,
        constraints: b.constraints as ListRef,
        reliesOn: b.reliesOn as ListRef,
        issues: [],
        revokes: neg.judgment,
        evidenceUse: b.evidenceUse,
        superseded: [],
        extends: null,
      };
      validateRecord(rec);
      records.push(rec);
    }
  }
  await commit(ctx, `flow:user-answer:${req.mission}:${esc.id}`, { events: [ev(ctx, SECRETARY_LINE, 'user-answer', esc.id, d)], records });
}

/** The ruling judgment on a position, made by the Secretary's launch or the user's answer (null: none). */
export async function rulingOf(ctx: FlowCtx, id: string): Promise<string | null> {
  for (const j of [`j.sec.${id}`, `j.user.${id}`]) if ((await judgmentRecordOf(ctx, j)) !== null) return j;
  return null;
}

/** Current versions of basis lines (re-exported for flows that bind decisions). */
export { currentVersions, basisIndex };
