// Shared fixtures of the exploration flow tests: the fakes of src/flow/fakes.ts, a definition,
// and scripted seat hand-backs (no model is ever called).

import type { MissionId } from '../src/common/ids.ts';
import { fakePorts, type FakeFlowEvaluator, type FakeFlowLedger, type FakeFlowScheduler } from '../src/flow/fakes.ts';
import { explorationDefinition, type ExplorationDefinition } from '../src/flow/exploration/definition.ts';
import { advanceExploration, defineExploration, type AdvanceReport } from '../src/flow/exploration/flow.ts';
import type { CrititorCard, CrititorResult } from '../src/seat/cards/crititor.ts';
import type { AuthorCard, AuthorResult } from '../src/seat/cards/researcher.ts';
import type { BlindResult } from '../src/seat/cards/experiment.ts';
import type { FlowTask } from '../src/flow/ports.ts';

export const M = 'M1' as MissionId;

export interface World {
  readonly ledger: FakeFlowLedger;
  readonly scheduler: FakeFlowScheduler;
  readonly evaluator: FakeFlowEvaluator;
  readonly x: string;
  advance(): Promise<AdvanceReport>;
}

export async function world(over: Omit<Partial<ExplorationDefinition>, 'budget'> & { rounds?: number } = {}): Promise<World> {
  const { ledger, scheduler, evaluator } = fakePorts();
  const x = over.exploration ?? 'E1';
  const def = explorationDefinition({
    exploration: x,
    mission: M,
    product: 'design',
    goal: 'no obvious logical hole, and nothing that gets stuck like the last version',
    decision: { type: 'structure', text: 'how the scheduler hands evidence back' },
    budget: { rounds: over.rounds ?? 8 },
    ...over,
  });
  await defineExploration({ ledger, scheduler }, def);
  return { ledger, scheduler, evaluator, x, advance: () => advanceExploration({ ledger, scheduler }, M, x) };
}

/** The one queued task (of a kind), or throws. */
export function only(w: World, kind?: string): FlowTask {
  const q = w.scheduler.queued(kind);
  if (q.length !== 1) throw new Error(`expected one queued ${kind ?? ''} task, found ${q.map((t) => t.task).join(', ') || 'none'}`);
  return q[0] as FlowTask;
}

export function submit(artifact: string, dispositions: AuthorResult['dispositions'] = [], extra: Partial<AuthorResult> = {}): AuthorResult {
  return { step: 'submit', message: 'new version', artifact, dispositions, directionQuestions: [], attempts: [], ...extra };
}

export function discuss(message: string): AuthorResult {
  return { step: 'discuss', message, artifact: '', dispositions: [], directionQuestions: [], attempts: [] };
}

export function attack(findings: CrititorResult['findings'] = [], rechecks: CrititorResult['rechecks'] = []): CrititorResult {
  return { findings, rechecks, settled: [], reply: 'assessment' };
}

export function finding(severity: 'fatal' | 'serious' | 'general' | 'minor', cls: string, title: string): CrititorResult['findings'][number] {
  return { severity, class: cls, title, basis: `the passage on ${title}`, consequence: 'it goes wrong', direction: 'fix it', evidence: [] };
}

/** Re-check every finding awaiting it on the attacker's card. */
export function recheckAll(card: CrititorCard, resolved: 'yes' | 'no', evidence: string[] = []): CrititorResult['rechecks'] {
  return card.priorFindings.filter((f) => f.status === 'awaiting-recheck').map((f) => ({ finding: f.id, resolved, reason: resolved === 'yes' ? 'fixed in this version' : 'still there', evidence }));
}

/** Revise every open finding on the author's card. */
export function reviseAll(card: AuthorCard): AuthorResult['dispositions'] {
  return card.openFindings.map((f) => ({ finding: f.id, action: 'revise' as const, note: 'changed' }));
}

/** A blind hand-back whose claims cite records: run:1 for an experiment, a snapshot file for a reading. */
export function blind(card: { seat?: string; steps: readonly string[]; measure: readonly string[]; assertions: readonly string[] }, holds: 'yes' | 'no' = 'yes'): BlindResult {
  const ptr = card.seat === 'researcher-reader' ? 'file:README.md:1' : 'run:1';
  return {
    steps: card.steps.map((_, i) => ({ step: i + 1, done: 'yes' as const, note: 'done' })),
    measurements: card.measure.map((m) => ({ measure: m, value: '42', source: `stdout of ${ptr}` })),
    assertions: card.assertions.map((_, i) => ({ assertion: i + 1, holds, basis: `exit code of ${ptr}` })),
    observations: '',
  };
}

/** The run records the seat host commits with an experiment's hand-back (one completed run per entry). */
export function withRuns(w: World, task: string, statuses: ReadonlyArray<'completed' | 'resource-exceeded'> = ['completed']): void {
  const t = w.scheduler.tasks.get(task);
  if (t?.handBack == null) throw new Error(`no hand-back on ${task}`);
  const launch = t.handBack.launch;
  const runs = statuses.map((status, i) => ({ kind: 'run.layer' as const, launch, run: `${launch}.run${i + 1}` as never, finalOom: 0, finalOomKill: 0, oomDelta: 0, oomKillDelta: 0, status }));
  t.handBack = { ...t.handBack, records: [...t.handBack.records, ...runs] };
}

/** Run the one queued task of a kind with a hand-back; throws on refused hand-backs. */
export function hand(w: World, kind: string, result: unknown): FlowTask {
  const t = only(w, kind);
  const problems = w.scheduler.run(t.task, { handBack: result });
  if (problems.length > 0) throw new Error(`hand-back refused: ${problems.join('; ')}`);
  // an experiment ran its commands: the host commits their run records with the hand-back
  if (kind === 'constructor-experiment') withRuns(w, t.task);
  return t;
}

export function cardOf<C>(w: World, kind: string): C {
  return only(w, kind).card as unknown as C;
}
