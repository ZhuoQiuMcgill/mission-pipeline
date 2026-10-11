// Shared fixtures of the exploration flow tests: the flows' ports on a project memory
// (test/flow-memory-fixtures.ts), a definition, and scripted seat hand-backs (no model is ever
// called). Every attack round is judged by the Stabilizer (4.1 §6.3): once the author disposed of
// its findings, or at once when it left the author nothing to answer. Unless a test turns it off,
// the fixture hands back the Stabilizer's default judgment (every finding in scope at the
// attacker's severity, the round on track), so the 4.0 rules of the rounds stay what is tested.

import type { MissionId } from '../src/common/ids.ts';
import { memoryPorts, type HarnessLedger, type HarnessScheduler, type MemoryWorld } from './flow-memory-fixtures.ts';
import type { MemoryFlowEvaluator } from '../src/process/index.ts';
import type { StabilizerCard, StabilizerResult } from '../src/seat/cards/stabilizer.ts';
import { explorationDefinition, type ExplorationDefinition } from '../src/flow/exploration/definition.ts';
import { advanceExploration, defineExploration, type AdvanceReport } from '../src/flow/exploration/flow.ts';
import { attackOutcome, type CrititorCard, type CrititorResult } from '../src/seat/cards/crititor.ts';
import type { AuthorCard, AuthorResult } from '../src/seat/cards/researcher.ts';
import type { BlindResult } from '../src/seat/cards/experiment.ts';
import type { FlowTask } from '../src/flow/ports.ts';

export const M = 'M1' as MissionId;

export interface World {
  readonly ledger: HarnessLedger;
  readonly scheduler: HarnessScheduler;
  readonly evaluator: MemoryFlowEvaluator;
  readonly memory: MemoryWorld['memory'];
  readonly ports: MemoryWorld;
  readonly x: string;
  /** Hand back the Stabilizer's default judgment whenever a round is to be stabilized (default true). */
  autoStabilize: boolean;
  advance(): Promise<AdvanceReport>;
}

export async function world(over: Omit<Partial<ExplorationDefinition>, 'budget'> & { rounds?: number } = {}): Promise<World> {
  const ports = memoryPorts();
  const { ledger, scheduler, evaluator } = ports;
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
  return { ledger, scheduler, evaluator, memory: ports.memory, ports, x, autoStabilize: true, advance: () => advanceExploration({ ledger, scheduler }, M, x) };
}

/** The Stabilizer's default judgment: every finding of the round in scope at the attacker's severity, the round on track. */
export function stabilizeAll(card: StabilizerCard, verdict: 'in-scope' | 'shifts-direction' | 'out-of-scope' = 'in-scope', o: { severity?: StabilizerResult['findings'][number]['severity']; drifting?: boolean } = {}): StabilizerResult {
  return {
    findings: card.findings.map((f) => ({ finding: f.id, verdict, severity: o.severity ?? f.severity, reason: `judged ${verdict}`, question: verdict === 'shifts-direction' ? `does ${f.title} change the question?` : '' })),
    round: { verdict: o.drifting === true ? 'drifting' : 'on-track', reason: o.drifting === true ? 'moved away' : 'answers the question', question: o.drifting === true ? 'is the question still the same?' : '' },
  };
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
/** The placeholder a blind experiment's claims cite; hand() replaces it with the run id of the dispatch's rerun. */
export const RUN_PLACEHOLDER = 'run:RUN-ID';

export function blind(card: { seat?: string; steps: readonly string[]; measure: readonly string[]; assertions: readonly string[]; network?: { allowed: readonly string[] } }, holds: 'yes' | 'no' = 'yes'): BlindResult {
  const ptr = card.seat === 'researcher-reader' ? `url:${card.network?.allowed[0] ?? 'https://example.org/'}doc` : RUN_PLACEHOLDER;
  return {
    steps: card.steps.map((_, i) => ({ step: i + 1, done: 'yes' as const, note: 'done' })),
    measurements: card.measure.map((m) => ({ measure: m, value: '42', source: `stdout of ${ptr}` })),
    assertions: card.assertions.map((_, i) => ({ assertion: i + 1, holds, basis: `exit code of ${ptr}` })),
    observations: '',
  };
}

/**
 * Run the one queued task of a kind with a hand-back; throws on refused hand-backs. An experiment
 * first has `mp` rerun its command (a run of the dispatch, `runs` statuses), and its claims cite it.
 * When the hand-back leaves a round to stabilize (an author's or interpreter's disposition, or an
 * attack that left the author nothing to answer), the Stabilizer's default judgment is handed back
 * too, unless the test turned it off.
 */
export async function hand(w: World, kind: string, result: unknown, o: { runs?: ReadonlyArray<'completed' | 'failed'> } = {}): Promise<FlowTask> {
  const t = only(w, kind);
  let fields = result;
  if (kind === 'constructor-experiment') {
    const d = w.scheduler.dispatchOf(t.task);
    const runs = (o.runs ?? ['completed']).map((st) => w.scheduler.rerun(d, 'step', st === 'completed'));
    fields = JSON.parse(JSON.stringify(result).split(RUN_PLACEHOLDER).join(`run:${runs[0] ?? 'none'}`));
  }
  const problems = await w.scheduler.run(t.task, { handBack: fields });
  if (problems.length > 0) throw new Error(`hand-back refused: ${problems.join('; ')}`);
  // an attack the attacker passed goes to the Stabilizer at once; one it did not pass waits for the author's disposition first
  const attackPassed = kind === 'crititor' && attackOutcome((t.card as unknown as CrititorCard).priorFindings, result as CrititorResult).verdict === 'pass';
  if (w.autoStabilize && (kind === 'researcher-author' || kind === 'researcher-interpreter' || attackPassed)) {
    await w.advance();
    const st = w.scheduler.queued('stabilizer')[0];
    if (st !== undefined) {
      const sp = await w.scheduler.run(st.task, { handBack: stabilizeAll(st.card as unknown as StabilizerCard) });
      if (sp.length > 0) throw new Error(`stabilizer hand-back refused: ${sp.join('; ')}`);
    }
  }
  return t;
}

export function cardOf<C>(w: World, kind: string): C {
  return only(w, kind).card as unknown as C;
}
