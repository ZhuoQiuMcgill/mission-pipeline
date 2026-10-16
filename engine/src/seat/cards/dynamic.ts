import type { CurrentItem, ConstraintBody, ItemVersionBody } from '../../flow/requirements.ts';
import type { FlowEvent } from '../../flow/ports.ts';
import type { DetailedTask } from '../../flow/plandoc.ts';
import type { DecisionBody, EscalationBody } from '../../flow/secretary.ts';
import { scopesOverlap } from '../../flow/mechanical.ts';
import { canonicalJson } from '../../common/hash.ts';
import { materialPageCount, type MaterialRef } from './common.ts';

/** Instructions are seat context; object constraints retain their proof scope semantics. */
export function constraintsForTask(constraints: readonly ConstraintBody[], task: Pick<DetailedTask, 'kind' | 'writeScope'>, mission: string): ConstraintBody[] {
  return constraints.filter((c) => {
    const paths = scopesOverlap(c.scope.paths, task.writeScope).length > 0;
    if (c.scope.mission !== undefined && c.scope.mission !== mission) return false;
    // a write scope is a set of patterns: overlap decides, never a display string as a concrete path
    return c.kind === 'object' ? (c.scope.taskTypes.length === 0 || c.scope.taskTypes.includes(task.kind)) && paths
      : c.scope.taskTypes.length > 0 ? c.scope.taskTypes.includes(task.kind) || (c.scope.paths.some((p) => p !== '**') && paths) : paths;
  });
}

/** Shared selection for queued and dispatched cards, including answers under the current spec only. */
export function taskDecisionQuotes(items: readonly CurrentItem[], events: readonly FlowEvent[], task: Pick<DetailedTask, 'id' | 'requirementItems'>, constraints: readonly ConstraintBody[]): string[] {
  const spec = events.filter((e) => e.line === `task:${task.id}` && e.event === 'spec').at(-1);
  const dplan = (spec?.body as { dplan?: string } | undefined)?.dplan;
  const effective = events.find((e) => e.line === 'plan' && e.event === 'effective' && (e.body as { dplan: string }).dplan === dplan)?.revision ?? events.filter((e) => e.line === 'plan' && e.event === 'effective').at(-1)?.revision ?? 0;
  const related = new Set(task.requirementItems);
  for (const i of items) if (related.has(i.line) && i.source.kind === 'authorization') related.add(i.source.line);
  for (const c of constraints) related.add(c.line);
  const out: string[] = [];
  for (const i of items) {
    if (i.type !== 'decision' || i.state !== 'valid') continue;
    if (i.source.kind === 'authorization' && !items.some((a) => a.line === (i.source as { line: string }).line && a.type === 'authorization' && a.state === 'valid')) continue;
    const recorded = events.find((e) => e.line === 'requirements' && e.event === 'item' && (e.body as ItemVersionBody).version === i.version)?.revision ?? 0;
    const after = effective > 0 && recorded > effective;
    const linked = related.has(i.line) || i.source.kind === 'authorization' || constraints.some((c) => c.text.includes(i.line));
    if (linked || after) out.push(`${i.text}${after ? ' (recorded after the plan)' : ''}`);
  }
  for (const e of events) {
    if (e.line !== 'secretary' || e.event !== 'escalation' || e.revision <= (spec?.revision ?? 0)) continue;
    const esc = e.body as EscalationBody;
    if (esc.subject !== `task:${task.id}`) continue;
    const applied = events.find((a) => a.line === 'secretary' && a.event === 'applied' && a.key === esc.id);
    const what = applied?.body as { what?: { option?: string }; by?: string } | undefined;
    if (what?.what?.option !== 'answer') continue;
    const answers = events.filter((a) => a.line === 'secretary' && ((a.event === 'user-answer' && a.key === esc.id) || (a.event === 'decision' && (a.body as DecisionBody).escalation === esc.id)));
    const d = (answers.find((a) => a.event === 'user-answer') ?? answers.at(-1))?.body as DecisionBody | undefined;
    if (d?.option === 'answer' && d.by === what.by && d.instructions !== '') out.push(d.instructions);
  }
  return [...new Set(out)];
}

export function taskRequirementItems(items: readonly CurrentItem[], task: Pick<DetailedTask, 'requirementItems'>) {
  return task.requirementItems.map((line) => ({ id: line, text: items.find((i) => i.line === line)?.text ?? '(this item is not in force)' }));
}

export function reviewerDecisionQuotes(mission: string, items: readonly CurrentItem[], events: readonly FlowEvent[], task: DetailedTask, constraints: readonly ConstraintBody[], attempt: number) {
  const answers = events.filter((e) => e.line === `task:${task.id}` && e.event === 'reanswer' && e.key.startsWith(`${attempt}:`)).map((e) => (e.body as { decision: string }).decision);
  return [...taskDecisionQuotes(items, events, task, constraintsForTask(constraints, task, mission)), ...answers];
}

export function secretaryRoundInputs(esc: EscalationBody, events: readonly FlowEvent[]) {
  const retries = events.filter((e) => e.line === 'secretary' && e.event === 'secretary-retry' && (e.body as { id: string }).id === esc.id);
  const retry = retries.at(-1);
  const body = retry?.body as { task: string; why: string } | undefined;
  return { esc: body === undefined ? esc : { ...esc, task: body.task, reasons: [...esc.reasons, body.why] }, key: retry?.key ?? esc.id, round: retries.length };
}

/** The Secretary's involved items and current facts belong to its builder, at queue and claim. */
export function secretaryInputs(mission: string, e: EscalationBody, items: readonly CurrentItem[], allConstraints: readonly ConstraintBody[], events: readonly FlowEvent[], task: DetailedTask | undefined, grantAvailable: boolean, put: (text: string) => string) {
  const constraints = task === undefined ? allConstraints.filter((c) => c.scope.mission === undefined || c.scope.mission === mission) : constraintsForTask(allConstraints, task, mission);
  const auths = items.filter((i) => i.type === 'authorization' && i.state === 'valid');
  const involved = items.filter((i) => (e.items ?? []).includes(i.line) || i.type === 'decision');
  const decisions = involved.filter((i) => i.type === 'decision' && i.state === 'valid' && (i.source.kind !== 'authorization' || auths.some((a) => i.source.kind === 'authorization' && a.line === i.source.line)));
  const selectedItems = involved.filter((i) => i.type !== 'decision' || decisions.includes(i));
  const decisionAuthorities = new Set(decisions.flatMap((i) => i.source.kind === 'authorization' ? [i.source.line] : []));
  const material = (id: string, title: string, text: string, role: MaterialRef['role']): MaterialRef => ({ id, title, ref: put(text), pages: materialPageCount(text), mustRead: true, role });
  const request = [`Escalation ${e.id} from ${e.source} on ${e.subject}`, e.summary, e.original ? `Original:\n${e.original}` : '', e.changed ? `Changed:\n${e.changed}` : '', e.reasons.length > 0 ? `Reasons:\n${e.reasons.map((r) => `- ${r}`).join('\n')}` : '', e.facts !== undefined ? `Facts:\n${JSON.stringify(e.facts, null, 2)}` : ''].filter(Boolean).join('\n\n');
  const batches = events.filter((b) => b.line === 'plan' && b.event === 'pm-batch');
  const decisionQuotes = decisions.map((i) => i.text);
  return {
    decisionQuotes,
    constraints: constraints.map((c) => ({ id: c.line, kind: c.kind, text: c.text })),
    authorizations: auths.map((a) => ({ id: a.line, version: a.version, quote: a.source.kind === 'words' ? a.source.quote : a.text, notifyCondition: a.notifyCondition })),
    items: selectedItems.map((i) => ({ id: i.line, text: i.text })),
    contextItems: [...auths, ...decisions].map((i) => ({ line: i.line, version: i.version, type: decisionAuthorities.has(i.line) ? 'decision-authority' : i.type })),
    grantAvailable,
    materials: [
      material('request', 'The escalated question and its facts', request, 'record'),
      material('authorizations', 'Authorizations in force (verbatim)', auths.map((a) => `[${a.line}] ${a.text}${a.source.kind === 'words' ? ` — "${a.source.quote}"` : ''}`).join('\n') || '(none)', 'authorizations'),
      material('alignment', 'Alignment record (PM batches)', batches.map((b) => `${b.key}: user messages ${(b.body as { userWords: string[] }).userWords.join(', ') || 'none'}`).join('\n') || '(none)', 'record'),
      material('current-facts', 'Current escalation facts', canonicalJson({ escalation: e, items: selectedItems, authorizations: auths, constraints, decisions: decisionQuotes, task: task ?? null, taskState: task === undefined ? [] : events.filter((x) => x.line === `task:${task.id}`).map((x) => ({ event: x.event, key: x.key, body: x.body })) }), 'record'),
    ],
  };
}

/** Null means a negation whose reach cannot be bounded. */
export function taskUsesDispute(mission: string, items: readonly CurrentItem[], pm: import('../../flow/plandoc.ts').PmPlanDoc, plan: import('../../flow/plandoc.ts').DetailedPlanDoc, task: DetailedTask, negated: readonly string[] | null): boolean {
  if (negated === null) return true;
  const contested = new Set(items.filter((i) => i.state === 'contested').map((i) => i.line));
  const seen = new Set<string>();
  const rests = (t: DetailedTask): boolean => {
    if (seen.has(t.id)) return false;
    seen.add(t.id);
    const origin = t.provenance;
    const element = origin === 'architect' ? undefined : pm.elements.find((e) => e.id === origin.planElement);
    if (t.requirementItems.some((i) => contested.has(i)) || element?.items.some((i) => contested.has(`item.${mission}.${i}`)) || (element !== undefined && negated.includes(element.id))) return true;
    return t.dependsOn.some((id) => { const dep = plan.tasks.find((x) => x.id === id); return dep !== undefined && rests(dep); });
  };
  return rests(task);
}
