// The exploration's cards (design 4.1 §6.3, §5.4; 4.0 4.3, 8.2, 6.2): built from the state alone
// (machine.ts) and an explicit selection of current object constraints for review cards. Every card carries what the memory
// knows (the product's current version, every finding with its disposition and the Stabilizer's
// verdict, the evidence executions, the discussion, the rulings), so a seat that continues after
// evidence loses only its conversation, never the facts: its new card carries its notes and the
// evidence (§5.4).

import { CARD_FORMAT, materialPageCount, type ContinuationT, type MaterialRef } from '../../seat/cards/common.ts';
import type { CrititorCard, EvidenceItemT, NewVersionT, PriorFindingT } from '../../seat/cards/crititor.ts';
import type { ExperimentCard } from '../../seat/cards/experiment.ts';
import type { AuthorCard, InterpreterCard, ReaderCard, RegisteredAttemptT } from '../../seat/cards/researcher.ts';
import type { StabilizerCard } from '../../seat/cards/stabilizer.ts';
import type { objectConstraints } from '../../seat/cards/inputs.ts';
import { SEAT_CAPABILITIES } from '../context.ts';
import type { FlowContent } from '../ports.ts';
import { xid } from './definition.ts';
import { allowedRounds, attemptEvidence, blocks, currentEvidence, effectiveSeverity, phaseFindings, type FindingState, type XState } from './machine.ts';

type ObjectConstraints = ReturnType<typeof objectConstraints>;

/** A continuation after async evidence (§5.4): the task that asked, its notes (a data value) and the evidence in words. */
export interface Resume {
  readonly previous: string;
  readonly notes: string | null;
  readonly evidence: string;
}

class Materials {
  readonly list: MaterialRef[] = [];
  private readonly content: FlowContent;
  constructor(content: FlowContent) {
    this.content = content;
  }
  add(id: string, title: string, ref: string, mustRead: boolean): string {
    if (!this.list.some((m) => m.id === id)) this.list.push({ id, title, ref, pages: materialPageCount(this.content.get(ref)), mustRead });
    return id;
  }
}

function defined(s: XState) {
  if (s.defined === null || s.def === null) throw new Error('exploration not defined');
  return { d: s.defined, def: s.def };
}

function common(s: XState, task: string, duties: string, resume: Resume | null, asyncEvidence: boolean, extraCaps: readonly string[] = [], m: Materials | null = null) {
  const { def } = defined(s);
  // a continuation's notes are a material of the new card (§5.4)
  const continuation: ContinuationT | null =
    resume === null ? null : { previous: resume.previous, notes: resume.notes !== null && m !== null ? m.add('notes', `Your notes from task ${resume.previous}`, resume.notes, true) : null, evidence: resume.evidence };
  return {
    format: CARD_FORMAT,
    task,
    mission: def.mission,
    module: def.module,
    // every seat runs a model (6.4: a stop on model use or on seats covers it), plus the definition's
    capabilities: [...new Set([...SEAT_CAPABILITIES, ...def.capabilities, ...extraCaps])],
    duties,
    decisionQuotes: def.decisionQuotes,
    constraints: def.constraints,
    ...(asyncEvidence ? { allowAsyncEvidence: true } : {}),
    ...(continuation !== null ? { continuation } : {}),
    // 4.1.2 (D-10): the repairs that reopened the exploration, an added question on every round's card
    ...(s.repairs.length > 0 ? { repairs: s.repairs.map((r) => ({ ...r })) } : {}),
  };
}

function readOnlyWorkspace(s: XState) {
  return { snapshot: defined(s).d.snapshot.path, writablePaths: [] as string[] };
}

function explorationRef(s: XState, focus: 'product' | 'method' | 'reasoning') {
  const { def } = defined(s);
  return { id: def.exploration, product: def.product, research: def.research, focus, question: def.question };
}

function focusOf(s: XState): 'product' | 'method' | 'reasoning' {
  return s.phase === 'method' ? 'method' : s.phase === 'reasoning' || s.phase === 'interpret' ? 'reasoning' : 'product';
}

function baseMaterials(s: XState, m: Materials): void {
  const { d, def } = defined(s);
  m.add('definition', 'The exploration definition', d.definitionDoc, false);
  for (const x of def.materials) m.add(`def-${x.id}`, x.title, x.doc, false);
}

function priorFinding(f: FindingState, m: Materials, i: number, mustRead: boolean): PriorFindingT {
  return {
    id: f.id,
    // the Stabilizer's severity once it judged the finding (4.1 §6.3)
    severity: effectiveSeverity(f),
    class: f.class,
    title: f.title,
    round: f.round,
    material: m.add(`finding-${i + 1}`, `Finding ${f.id.slice(0, 20)}: ${f.title}`.slice(0, 200), f.doc, mustRead),
    status: f.status,
    disposition: f.disposition === null ? null : { action: f.disposition.action, note: f.disposition.note, evidence: f.disposition.evidence, question: f.disposition.question },
    ruling: f.ruling,
    scope: f.scope,
    ...(f.answered !== null ? { answered: f.answered } : {}),
  };
}

function evidenceItems(s: XState, m: Materials, onlyExtra = false, mustRead: ReadonlySet<string> = new Set()): EvidenceItemT[] {
  return [...s.evidence.values()]
    .filter((e) => !onlyExtra || e.attempt === null)
    .sort((a, b) => a.k - b.k)
    .map((e) => ({ id: e.id, status: e.status, summary: e.summary, attempt: e.attempt, material: e.report !== null ? m.add(`evidence-${e.id}`, `Evidence ${e.id} report`, e.report, mustRead.has(e.id)) : null }));
}

function rulings(s: XState): string[] {
  return s.rulings.filter((r) => r.decision !== 'extend' && r.decision !== 'retry' && r.text.trim() !== '').map((r) => `(${r.decision}${r.findings.length > 0 ? ` on ${r.findings.join(', ')}` : ''}, by ${r.by}) ${r.text}`);
}

/** What a version of this phase relies on: a research interpretation, its method version (review r1 #2). */
export function versionReliesOn(s: XState): string[] {
  return (s.phase === 'reasoning' || s.phase === 'interpret') && s.method !== null ? [s.method.version] : [];
}

/**
 * The evidence the current version's standing rests on (review r1 #2): the runs that rebutted
 * findings now resolved, and for a research interpretation every record it cites (each attempt's
 * record and every cited evidence execution).
 */
export function versionEvidence(s: XState, content: FlowContent): string[] {
  // one resolver (code review r2 #5): every id through the reruns to its latest record; an attempt uses its latest record
  const out = new Set<string>();
  for (const f of phaseFindings(s)) if (f.status === 'resolved' && f.disposition?.action === 'rebut' && f.disposition.evidence !== null) out.add(currentEvidence(s, f.disposition.evidence));
  if (s.phase === 'reasoning' && s.version !== null) {
    const attempts = new Set((s.method?.attempts ?? []).map((a) => a.id));
    try {
      const doc = JSON.parse(content.get(s.version.content)) as { conclusions?: Array<{ cites?: string[] }> };
      for (const c of doc.conclusions ?? []) for (const x of c.cites ?? []) out.add(attempts.has(x) ? (attemptEvidence(s, x) ?? x) : currentEvidence(s, x));
    } catch {
      /* not an interpretation document */
    }
    for (const a of s.method?.attempts ?? []) {
      const e = attemptEvidence(s, a.id);
      if (e !== null) out.add(e);
    }
  }
  return [...out].filter((e) => s.evidence.has(e)).sort();
}

function newVersion(s: XState, n: number): NewVersionT {
  const { d, def } = defined(s);
  const relies = versionReliesOn(s.phase === 'interpret' ? { ...s, phase: 'reasoning' } : s);
  return {
    prefix: xid.versionPrefix(def.mission, def.exploration, n),
    objectKind: 'interpretation',
    scope: { paths: [xid.path(def.mission, def.exploration)], taskType: 'exploration' },
    reviews: [{ review: 'crititor', basisLines: [d.basisLine], reliesOn: relies }],
    predecessor: s.version?.id ?? null,
    prerequisites: relies,
  };
}

const AUTHOR_DUTIES =
  'You own this exploration\'s product. Each turn pick one step: discuss the framing, ask for evidence (request-evidence), or submit a new version with a disposition for every open finding.';

export function authorCard(s: XState, n: number, task: string, content: FlowContent, resume: Resume | null): AuthorCard {
  const { def } = defined(s);
  const m = new Materials(content);
  if (s.version !== null) m.add('version', `Current version ${s.version.id}`, s.version.content, true);
  baseMaterials(s, m);
  const all = [...s.findings.values()];
  const findings = phaseFindings(s);
  const open = findings.filter((f) => f.status === 'open');
  const other = findings.filter((f) => f.status !== 'open');
  return {
    ...common(s, task, def.duties.trim() !== '' ? def.duties : AUTHOR_DUTIES, resume, true, [], m),
    seat: 'researcher-author',
    workspace: readOnlyWorkspace(s),
    exploration: explorationRef(s, focusOf(s)),
    goal: def.goal,
    attackScope: def.attackScope,
    decision: def.decision,
    round: s.rounds,
    budgetRounds: allowedRounds(s),
    current: s.version === null ? null : { version: s.version.id, content: s.version.content, material: 'version' },
    openFindings: open.map((f) => priorFinding(f, m, all.indexOf(f), true)),
    otherFindings: other.map((f) => priorFinding(f, m, all.indexOf(f), false)),
    evidence: evidenceItems(s, m),
    discussion: [...s.discussion],
    rulings: rulings(s),
    materials: m.list,
    newVersion: newVersion(s, n),
    registerAttempts: s.phase === 'method',
  };
}

export function interpreterCard(s: XState, n: number, task: string, content: FlowContent): InterpreterCard {
  const { def } = defined(s);
  if (s.method === null) throw new Error('interpretation before the method passed');
  const m = new Materials(content);
  const methodVersion = s.versions.find((v) => v.id === s.method?.version);
  if (methodVersion === undefined) throw new Error(`method version ${s.method.version} unknown`);
  m.add('method', `Method ${methodVersion.id}`, methodVersion.content, true);
  const current = s.phase === 'reasoning' ? s.version : null;
  if (current !== null) m.add('version', `Current interpretation ${current.id}`, current.content, true);
  baseMaterials(s, m);
  const findings = s.phase === 'reasoning' ? phaseFindings(s) : [];
  const open = findings.filter((f) => f.status === 'open');
  const other = findings.filter((f) => f.status !== 'open');
  const all = [...s.findings.values()];
  return {
    ...common(s, task, 'Interpret the records of the registered attempts; you took part in none of the executions.', null, false),
    seat: 'researcher-interpreter',
    workspace: readOnlyWorkspace(s),
    exploration: explorationRef(s, 'reasoning'),
    goal: def.goal,
    attackScope: def.attackScope,
    method: { version: methodVersion.id, material: 'method' },
    attempts: s.method.attempts.map((a: RegisteredAttemptT) => {
      const latest = attemptEvidence(s, a.id);
      const e = latest !== null ? (s.evidence.get(latest) ?? null) : null;
      return {
        id: a.id,
        kind: a.kind,
        purpose: a.purpose,
        evidence: e?.id ?? null,
        status: e?.status ?? 'not-run',
        summary: e?.summary ?? 'no record',
        material: e !== null && e.report !== null ? m.add(`evidence-${e.id}`, `Attempt ${a.id} record`, e.report, true) : null,
      };
    }),
    evidence: evidenceItems(s, m, true),
    round: s.rounds,
    budgetRounds: allowedRounds(s),
    current: current === null ? null : { version: current.id, content: current.content, material: 'version' },
    openFindings: open.map((f) => priorFinding(f, m, all.indexOf(f), true)),
    otherFindings: other.map((f) => priorFinding(f, m, all.indexOf(f), false)),
    rulings: rulings(s),
    materials: m.list,
    newVersion: newVersion(s, n),
  };
}

export function attackerCard(s: XState, n: number, task: string, content: FlowContent, mode: 'attack' | 'discuss', fresh: boolean, resume: Resume | null, constraints: ObjectConstraints): CrititorCard {
  const { d, def } = defined(s);
  const m = new Materials(content);
  const target = s.version;
  if (mode === 'attack' && target === null) throw new Error('attack without a version');
  if (target !== null) m.add('version', `Version ${target.id} (attacked)`, target.content, mode === 'attack');
  const idx = target === null ? -1 : s.versions.findIndex((v) => v.id === target.id);
  const previous = idx > 0 ? (s.versions[idx - 1] ?? null) : null;
  if (previous !== null) m.add('previous', `Previous version ${previous.id}`, previous.content, false);
  baseMaterials(s, m);
  const all = [...s.findings.values()];
  const mine = phaseFindings(s);
  // the closing attacker gets a fresh view: only what is still to be checked, not the history
  const shown = fresh ? mine.filter((f) => f.status !== 'resolved') : mine;
  return {
    ...common(s, task, 'Attack the version adversarially and re-check every finding marked awaiting-recheck.', resume, true, [], m),
    seat: 'crititor',
    constraints: mode === 'attack' ? [...def.constraints.filter((c) => c.kind === 'instruction'), ...constraints.list] : [...def.constraints],
    workspace: readOnlyWorkspace(s),
    exploration: explorationRef(s, focusOf(s)),
    goal: def.goal,
    attackScope: def.attackScope,
    mode,
    fresh,
    round: s.rounds + 1,
    target: target?.id ?? null,
    review: 'crititor',
    previousTarget: previous?.id ?? null,
    priorFindings: shown.map((f) => priorFinding(f, m, all.indexOf(f), f.status === 'awaiting-recheck')),
    // a rebuttal's evidence report must be read before its re-check (8.2: does it cover the counterexample?)
    evidence: evidenceItems(s, m, false, new Set(shown.flatMap((f) => (f.status === 'awaiting-recheck' && f.disposition?.evidence != null ? [f.disposition.evidence] : [])))),
    discussion: fresh ? [] : [...s.discussion],
    rulings: rulings(s),
    materials: m.list,
    binding:
      mode === 'attack' && target !== null
        ? {
            judgment: xid.judgment(def.mission, def.exploration, n),
            bases: content.putList([d.basisVersion]),
            constraints: content.putList(constraints.checks),
            // the contract's objects (a research interpretation: its method version)
            reliesOn: content.putList(versionReliesOn(s)),
            revokes: s.negations.get(target.id) ?? null,
            extends: null,
            evidenceUse: { fields: ['record'], statisticalOrExternal: true },
            superseded: [],
          }
        : null,
    requiredEvidence: mode === 'attack' ? versionEvidence(s, content) : [],
  };
}

/** An evidence request as `mp seat <id> request-evidence` records it (src/seat/card.ts EvidenceRequestSchema). */
export interface EvidenceRequestDoc {
  readonly steps: readonly string[];
  readonly data: string;
  readonly measure: readonly string[];
  readonly assertions: readonly string[];
  readonly executor?: 'experiment' | 'reading';
  /** experiment: the commands the steps run (decision 11). */
  readonly commands?: ReadonlyArray<{ readonly id: string; readonly command: string; readonly cwd?: string }>;
}

export function parseEvidenceRequest(doc: string): EvidenceRequestDoc | null {
  try {
    const v = JSON.parse(doc) as Record<string, unknown>;
    const strings = (x: unknown): x is string[] => Array.isArray(x) && x.every((y) => typeof y === 'string');
    if (!strings(v['steps']) || v['steps'].length === 0 || typeof v['data'] !== 'string' || !strings(v['measure']) || !strings(v['assertions'])) return null;
    const ex = v['executor'];
    const cmds = v['commands'];
    const commands =
      Array.isArray(cmds) && cmds.every((c) => typeof c === 'object' && c !== null && typeof (c as { id?: unknown }).id === 'string' && typeof (c as { command?: unknown }).command === 'string')
        ? (cmds as Array<{ id: string; command: string; cwd?: string }>).map((c) => ({ id: c.id, command: c.command, ...(typeof c.cwd === 'string' ? { cwd: c.cwd } : {}) }))
        : [];
    return { steps: v['steps'], data: v['data'], measure: v['measure'], assertions: v['assertions'], ...(ex === 'experiment' || ex === 'reading' ? { executor: ex } : {}), ...(commands.length > 0 ? { commands } : {}) };
  } catch {
    return null;
  }
}

/** A blind executor's card (4.3: steps, data, quantities, assertions; no expectation). */
export function executorCard(
  s: XState,
  task: string,
  content: FlowContent,
  req: EvidenceRequestDoc,
  executor: 'experiment' | 'reading',
  evidence: { readonly id: string; readonly attempt: string | null },
): ExperimentCard | ReaderCard {
  const { d, def } = defined(s);
  // blind (4.3, review r1 #19): no material of the exploration (not the PM plan, not the document
  // under exploration, not the findings), no decision quotes; only the request's own data
  const m = new Materials(content);
  const blind = {
    steps: [...req.steps],
    data: req.data,
    measure: [...req.measure],
    assertions: [...req.assertions],
    evidence: { id: evidence.id, envLine: d.envLine, envSnapshot: d.envSnapshot, attempt: evidence.attempt },
    materials: m.list,
  };
  const duties = 'Carry out the evidence run exactly as the steps say and record what happened.';
  // execution instructions only: object constraints and decision quotes carry intent, not steps
  // blind: no intent (§4.3), so no repair either
  const blindCommon = (extra: readonly string[]) => { const { repairs: _repairs, ...c } = common(s, task, duties, null, false, extra) as ReturnType<typeof common> & { repairs?: unknown }; void _repairs; return { ...c, decisionQuotes: [], constraints: def.constraints.filter((k) => k.kind === 'instruction') }; };
  if (executor === 'reading') {
    const net = def.readingNetwork.length > 0 ? ['net'] : [];
    return { ...blindCommon(net), seat: 'researcher-reader', workspace: readOnlyWorkspace(s), network: { allowed: [...def.readingNetwork] }, ...blind };
  }
  return {
    ...blindCommon([]),
    seat: 'constructor-experiment',
    workspace: { snapshot: d.snapshot.path, writablePaths: [...def.experimentPaths] },
    interpreter: '',
    // decision 11: the step commands the executor runs with `mp seat <id> rerun <command-id>`
    commands: (req.commands ?? []).map((c) => ({ ...c })),
    ...blind,
  };
}

/**
 * The Stabilizer's card (4.1 §6.3): the definition (the maintainer's goal verbatim, the question,
 * the attack scope, the decision it serves), the round's findings with the author's
 * dispositions, earlier in-scope findings still open, the first and the current version, the
 * earlier rounds' judgments and the rulings. Its judgment binds the attack judgment's contract.
 */
export function stabilizerCard(s: XState, n: number, task: string, content: FlowContent, constraints: ObjectConstraints): StabilizerCard {
  const { d, def: current0 } = defined(s);
  const st = s.stabilizing;
  if (st === null) throw new Error('no round to stabilize');
  // the round's own definition version: the one its attacker card was built under (final review F1)
  const basis = st.basis ?? d.basisVersion;
  const pinned = s.definitions.get(basis);
  const def = pinned?.definition ?? current0;
  const definitionDoc = pinned?.definitionDoc ?? d.definitionDoc;
  const first = s.versions[0];
  const current = s.version;
  if (first === undefined || current === null) throw new Error('a round to stabilize without a version');
  const m = new Materials(content);
  m.add('first', `The first version ${first.id}`, first.content, true);
  if (current.id !== first.id) m.add('current', `The current version ${current.id}`, current.content, true);
  m.add('definition', 'The exploration definition', definitionDoc, true);
  const all = [...s.findings.values()];
  const round = new Set(st.findings);
  const findings = all.filter((f) => round.has(f.id));
  const earlier = phaseFindings(s).filter((f) => !round.has(f.id) && f.scope === 'in-scope' && f.status !== 'resolved' && blocks(f));
  return {
    ...common(s, task, 'Judge this round of the attack against the definition and the user\'s words: which findings bind the author, which shift the direction, and whether the work drifts.', null, false, [], m),
    seat: 'stabilizer',
    constraints: [...def.constraints.filter((c) => c.kind === 'instruction'), ...constraints.list],
    exploration: explorationRef(s, focusOf(s)),
    goal: def.goal,
    attackScope: def.attackScope,
    decision: { type: def.decision.type, text: def.decision.text },
    round: st.round,
    target: st.target,
    findings: findings.map((f) => priorFinding(f, m, all.indexOf(f), true)),
    earlier: earlier.map((f) => priorFinding(f, m, all.indexOf(f), false)),
    firstVersion: { version: first.id, material: 'first' },
    currentVersion: { version: current.id, material: current.id === first.id ? 'first' : 'current' },
    earlierJudgments: s.stabilizations.map(
      (j) => `round ${j.round} (${j.verdict}): ${j.drift.verdict}${j.drift.reason !== '' ? ` — ${j.drift.reason}` : ''}; ${j.findings.map((f) => `${f.finding.slice(0, 24)} ${f.verdict} (${f.severity})`).join(', ')}`,
    ),
    rulings: rulings(s),
    materials: m.list,
    binding: {
      judgment: xid.judgment(def.mission, def.exploration, n),
      bases: content.putList([basis]),
      constraints: content.putList(constraints.checks),
      reliesOn: content.putList(versionReliesOn(s)),
      revokes: s.negations.get(st.target) ?? null,
      extends: null,
      evidenceUse: { fields: ['record'], statisticalOrExternal: true },
      superseded: [],
    },
    requiredEvidence: [...st.evidence],
    pendingDirection: pendingDirectionOf(s, round),
  };
}

/** The direction questions waiting for a ruling apart from this round's findings (code review r1 #2). */
function pendingDirectionOf(s: XState, round: ReadonlySet<string>): string[] {
  const out: string[] = [];
  for (const q of s.pendingQuestions) for (const x of q.questions) out.push(`the author's question (task ${q.task}): ${x}`);
  for (const f of s.findings.values()) {
    if (round.has(f.id) || f.status !== 'awaiting-ruling') continue;
    out.push(`${f.disposition?.action === 'escalate' ? 'escalated by the author' : 'shifts direction'}: ${f.title}${f.disposition?.question ? ` (${f.disposition.question})` : f.question ? ` (${f.question})` : ''}`);
  }
  if (s.drift !== null) out.push(`round ${s.drift.round} drifting: ${s.drift.question ?? s.drift.reason}`);
  return out;
}
