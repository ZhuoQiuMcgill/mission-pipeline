// Scripted seat results for runs without models (tests, rehearsals): valid hand-backs for each
// decision-layer and execution card kind, and a driver that alternates the engine with the
// fake scheduler until nothing scripted is left to run.

import type { ReviewerCard } from '../seat/card.ts';
import type { ConstructorResult, ReviewerResult } from '../seat/results.ts';
import type { ArchitectDecomposeResult, ArchitectFeasibilityCard, ArchitectFeasibilityResult } from '../seat/cards/architect.ts';
import type { Calibrator1Card, Calibrator1Result, Calibrator2Card, Calibrator2Result } from '../seat/cards/calibrator.ts';
import type { DecisionOption, SecretaryCard, SecretaryResult } from '../seat/cards/secretary.ts';
import type { FlowEngine } from './engine.ts';
import type { FakeFlowScheduler, FakeOutcome } from './fakes.ts';
import type { DetailedPlanDoc } from './plandoc.ts';
import type { FlowTask } from './ports.ts';

export function cal1Pass(c: Calibrator1Card): Calibrator1Result {
  return {
    elements: c.focus.map((e) => ({ element: e, finding: 'user-said', quotes: [`${c.materials[0]?.id ?? 'words'}#1`], reason: 'the user said it' })),
    errors: [],
    explorations: c.explorations.map((x) => ({ exploration: x, presetAnswer: false, jumpsAhead: false, detail: 'fine' })),
    questions: [],
    verdict: 'pass',
  };
}

/** One focus element contradicts the user (or needs the user's decision, with a question). */
export function cal1Fail(c: Calibrator1Card, element: string, how: 'contradicts-user' | 'ask-user'): Calibrator1Result {
  const p = cal1Pass(c);
  return {
    ...p,
    elements: p.elements.map((e) => (e.element === element ? { ...e, finding: how, quotes: [], reason: how === 'ask-user' ? 'an irreversible choice the user has not made' : 'the user said the opposite' } : e)),
    questions: how === 'ask-user' ? [{ element, question: `Do you want ${element}?`, why: 'irreversible' }] : [],
    verdict: 'fail',
  };
}

export function cal2Pass(c: Calibrator2Card): Calibrator2Result {
  const byId = new Map(c.elements.map((e) => [e.id, e]));
  return {
    mappings: c.focus.filter((f) => (byId.get(f)?.mapsTo ?? null) !== null).map((e) => ({ element: e, faithful: true, reason: 'faithful' })),
    supplements: c.focus.filter((f) => (byId.get(f)?.mapsTo ?? null) === null).map((e) => ({ element: e, finding: 'detail', reason: 'a detail' })),
    verdict: 'pass',
    escalation: '',
  };
}

export function cal2Escalate(c: Calibrator2Card, why: string): Calibrator2Result {
  const p = cal2Pass(c);
  const first = p.supplements[0];
  if (first !== undefined) return { ...p, supplements: p.supplements.map((s, i) => (i === 0 ? { ...s, finding: 'important-decision', reason: why } : s)), verdict: 'escalate', escalation: why };
  return { ...p, mappings: p.mappings.map((m, i) => (i === 0 ? { ...m, faithful: false, reason: why } : m)), verdict: 'escalate', escalation: why };
}

export function architect(plan: DetailedPlanDoc): ArchitectDecomposeResult {
  return plan;
}

export function feasible(): ArchitectFeasibilityResult {
  return { findings: [], criticalPath: [], verdict: 'feasible' };
}

export function feasibilityReturn(c: ArchitectFeasibilityCard, detail: string): ArchitectFeasibilityResult {
  const t = c.plan.tasks[0]?.id ?? 'x';
  return { findings: [{ id: 'F1', category: 'capacity', severity: 'blocking', tasks: [t], detail, suggestion: 'split it' }], criticalPath: [t], verdict: 'return' };
}

export function secretary(c: SecretaryCard, option: DecisionOption, o: { classification?: SecretaryResult['classification']; instructions?: string; grantExtra?: number; authorization?: string | null; notice?: string } = {}): SecretaryResult {
  const classification = o.classification ?? (option === 'ask-user' ? 'needs-user' : 'detail');
  return {
    option,
    classification,
    authorization: o.authorization ?? (classification === 'important-within-authority' ? (c.authorizations[0]?.id ?? null) : null),
    reason: `scripted: ${option}`,
    instructions: o.instructions ?? (['send-back', 'replan', 'rework', 'answer'].includes(option) ? `scripted instructions for ${option}` : ''),
    grantExtra: option === 'grant' ? (o.grantExtra ?? 1) : 0,
    notice: o.notice ?? (classification === 'detail' ? '' : `scripted notice: ${option}`),
    mayMatter: false,
  };
}

export function constructorDone(o: Partial<ConstructorResult> = {}): ConstructorResult {
  return { done: 'implemented', unmet_standards: [], unfixed_problems: [], decisions_needed: [], ...o };
}

export function reviewer(c: ReviewerCard, verdict: ReviewerResult['verdict'], o: { findings?: string[]; failing?: string } = {}): ReviewerResult {
  const ev = c.verificationRuns[0]?.evidence;
  return {
    judgments: c.standards.map((s) => ({
      standard: s.id,
      met: verdict === 'pass' ? 'yes' : s.id === (o.failing ?? c.standards[0]?.id) ? (verdict === 'rework' ? 'no' : 'unclear') : 'yes',
      reason: 'checked',
      evidence: ev !== undefined ? [`evidence:${ev}`] : ['file:index.ts:1'],
    })),
    gap_responses: c.selfReportedGaps.map((g) => ({ gap: g.id, response: 'noted' })),
    issue_responses: c.openIssues.map((i) => ({ issue: i.issue, response: verdict === 'pass' ? 'fixed' : 'not-fixed', reason: 'checked' })),
    findings: o.findings ?? [],
    verdict,
  };
}

/** What to do with a queued task: an outcome, or null to leave it queued. */
export type Script = (task: FlowTask, scheduler: FakeFlowScheduler) => FakeOutcome | null;

/**
 * Alternate reconcile and scripted runs until nothing scripted is queued. Returns the tasks run,
 * in order. Throws when a scripted hand-back is refused by the program's rules (a test defect).
 */
export async function drive(engine: FlowEngine, scheduler: FakeFlowScheduler, script: Script, maxRounds = 200): Promise<string[]> {
  const ran: string[] = [];
  for (let round = 0; round < maxRounds; round++) {
    const reports = await engine.reconcile();
    for (const r of reports) if (r.errors.length > 0) throw new Error(`flow errors in ${r.mission}: ${r.errors.map((e) => `${e.step}: ${e.message}`).join('; ')}`);
    let any = false;
    for (const t of scheduler.queued()) {
      const o = script(t, scheduler);
      if (o === null) continue;
      const problems = scheduler.run(t.task, o);
      if (problems.length > 0) throw new Error(`scripted hand-back for ${t.task} refused:\n- ${problems.join('\n- ')}`);
      ran.push(t.task);
      any = true;
    }
    if (!any) {
      await engine.reconcile();
      return ran;
    }
  }
  throw new Error('drive: too many rounds');
}

// ---------------------------------------------------------------- a seeded mission

import type { MissionId } from '../common/ids.ts';
import type { FakeFlowLedger } from './fakes.ts';
import type { FlowPorts } from './ports.ts';
import { itemLine, recordItem } from './requirements.ts';
import type { PmPlanDoc } from './plandoc.ts';

/** Book a user message (what the PM session's prompt hook does, 3.1). */
export function bookWords(ledger: FakeFlowLedger, message: string, text: string): void {
  ledger.commit([{ kind: 'user.words', message, session: 'pm-session', at: 1_000 + ledger.head, text: ledger.content.put(text), excerpt: text.slice(0, 280) }]);
}

/** A mission with the user's words, a goal, an acceptance item and an authorization recorded. */
export async function seedMission(ports: FlowPorts & { ledger: FakeFlowLedger }, mission: MissionId): Promise<void> {
  bookWords(ports.ledger, 'msg1', 'Build me a CSV parser with tests. The details are yours to decide.');
  await recordItem(ports, { mission, item: 'g1', type: 'goal', text: 'A CSV parser', source: { kind: 'words', message: 'msg1', quote: 'Build me a CSV parser' } });
  await recordItem(ports, { mission, item: 's1', type: 'acceptance', text: 'It has tests', source: { kind: 'words', message: 'msg1', quote: 'with tests' } });
  await recordItem(ports, { mission, item: 'a1', type: 'authorization', text: 'Details are the PM\'s', source: { kind: 'words', message: 'msg1', quote: 'The details are yours to decide' } });
}

/** A two-element PM plan for the seeded mission. */
export function pmPlan(mission: string, o: Partial<PmPlanDoc> = {}): PmPlanDoc {
  return {
    format: 'mp4.pm-plan.v1',
    mission,
    round: 1,
    order: 'free',
    elements: [
      { id: 'e1', kind: 'deliverable', text: 'A CSV parser library', provenance: { by: 'user', message: 'msg1', quote: 'Build me a CSV parser' }, after: [], items: ['g1'] },
      { id: 'e2', kind: 'behavior', text: 'Covered by unit tests', provenance: { by: 'user', message: 'msg1', quote: 'with tests' }, after: [], items: ['s1'] },
    ],
    goalsBeyond: [],
    authorizations: ['a1'],
    ...o,
  };
}

/** A detailed plan for pmPlan(): an interface task and an implementation task that depends on it. */
export function detailedPlan(mission: string, o: { implProvenance?: string; extraTask?: boolean } = {}): DetailedPlanDoc {
  const item = (i: string): string => itemLine(mission, i);
  return {
    reusedInterfaces: [],
    newInterfaces: [{ name: 'Parser', definition: 'parse(text: string): string[][]', searched: 'searched src/ for existing parsers: none', provenance: { planElement: 'e1' } }],
    modules: [{ id: 'parser', writeScope: ['src/parser/**'], provenance: { planElement: 'e1' } }],
    tasks: [
      {
        id: 'iface',
        kind: 'interface',
        module: 'parser',
        goal: 'Define the Parser interface',
        standards: [{ id: 'S1', text: 'The interface compiles' }],
        requirementItems: [item('g1')],
        writeScope: ['src/parser/api.ts'],
        readableFiles: [],
        interpreter: 'node',
        verificationCommands: [{ id: 'tsc', command: 'npx tsc --noEmit' }],
        implements: ['Parser'],
        calls: [],
        dependsOn: [],
        exclusive: [],
        estimate: { durationMs: 60_000, costMicros: 300_000, basis: 'a similar interface took a minute' },
        provenance: { planElement: 'e1' },
      },
      {
        id: 'impl',
        kind: 'implementation',
        module: 'parser',
        goal: 'Implement the parser with unit tests',
        standards: [
          { id: 'S1', text: 'Parses quoted fields' },
          { id: 'S2', text: 'Unit tests pass' },
        ],
        requirementItems: [item('g1'), item('s1')],
        writeScope: ['src/parser/impl/**'],
        readableFiles: ['src/parser/api.ts'],
        interpreter: 'node',
        verificationCommands: [{ id: 'test', command: 'npm test' }],
        implements: ['Parser'],
        calls: [],
        dependsOn: ['iface'],
        exclusive: [],
        estimate: { durationMs: 300_000, costMicros: 1_000_000, basis: 'past parser work' },
        provenance: { planElement: o.implProvenance ?? 'e2' },
      },
      ...(o.extraTask
        ? [
            {
              id: 'docs',
              kind: 'integration' as const,
              module: null,
              goal: 'Integrate and document the parser',
              standards: [{ id: 'S1', text: 'A README exists' }],
              requirementItems: [],
              writeScope: ['docs/parser.md'],
              readableFiles: [],
              interpreter: '',
              verificationCommands: [],
              implements: [],
              calls: [],
              dependsOn: ['impl'],
              exclusive: [],
              estimate: { durationMs: 60_000, costMicros: 100_000, basis: 'small' },
              provenance: { planElement: 'e2' },
            },
          ]
        : []),
    ],
    risks: [],
  };
}

/** The script of a run where every seat agrees (overridable by kind). */
export function happyScript(mission: string, plan: () => DetailedPlanDoc = () => detailedPlan(mission)): Script {
  return (t) => {
    const c = t.card as never;
    switch (t.card.seat) {
      case 'calibrator-1':
        return { handBack: cal1Pass(c) };
      case 'architect-decompose':
        return { handBack: architect(plan()) };
      case 'architect-feasibility':
        return { handBack: feasible() };
      case 'calibrator-2':
        return { handBack: cal2Pass(c) };
      case 'constructor':
        return { handBack: constructorDone() };
      case 'reviewer':
        return { handBack: reviewer(c, 'pass') };
      case 'secretary':
        return { handBack: secretary(c, (c as SecretaryCard).options[0]?.id ?? 'ask-user') };
      default:
        return null;
    }
  };
}
